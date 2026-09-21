import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type {
	HubChannel,
	HubMessage,
	HubSendMessageParams,
	HubSendMessageResult,
} from "@thinkrail/contracts";
import { logger } from "../../log";
import type { TelegramAccountConfig } from "../accounts";
import {
	detectMessageUrgency,
	generateMessageSnippet,
	getAccount,
	getHubDb,
	saveChannel,
	saveIncomingMessages,
	saveMessage,
	updateAccountStatus,
} from "../db";
import { registerHubAccountSyncer, registerHubMessageSender } from "../handlers";
import { publishHubAccountStatus, publishHubMessage } from "../publishers";

const log = logger("hub:telegram");

// ---------------------------------------------------------------------------
// Telegram Types
// ---------------------------------------------------------------------------

export interface TelegramUser {
	id: number;
	is_bot?: boolean;
	first_name: string;
	last_name?: string;
	username?: string;
}

export interface TelegramChat {
	id: number | string;
	type: "private" | "group" | "supergroup" | "channel";
	title?: string;
	username?: string;
	first_name?: string;
	last_name?: string;
}

export interface TelegramRawMessage {
	message_id: number;
	from?: TelegramUser;
	chat: TelegramChat;
	date: number;
	text?: string;
	caption?: string;
	reply_to_message?: {
		message_id: number;
		text?: string;
	};
}

export interface TelegramUpdate {
	update_id: number;
	message?: TelegramRawMessage;
	channel_post?: TelegramRawMessage;
	edited_message?: TelegramRawMessage;
}

// ---------------------------------------------------------------------------
// Telegram Client Interfaces & Implementations
// ---------------------------------------------------------------------------

export interface TelegramClientInterface {
	getMe(): Promise<{ id: number; username?: string; firstName: string }>;
	fetchUpdates(
		offset?: number,
		limit?: number,
	): Promise<{ updates: TelegramUpdate[]; nextOffset: number }>;
	sendMessage(
		chatId: string | number,
		text: string,
		replyToMessageId?: string | number,
	): Promise<{ messageId: string | number }>;
}

export class MockTelegramClient implements TelegramClientInterface {
	public updatesQueue: TelegramUpdate[] = [];
	public sentMessages: Array<{
		chatId: string | number;
		text: string;
		replyToMessageId?: string | number;
		messageId: number;
	}> = [];
	public botUser = { id: 12345678, username: "ThinkRailBot", firstName: "ThinkRail Bot" };
	private currentMessageId = 1000;

	constructor(initialUpdates: TelegramUpdate[] = []) {
		this.updatesQueue = [...initialUpdates];
	}

	async getMe(): Promise<{ id: number; username?: string; firstName: string }> {
		return {
			id: this.botUser.id,
			username: this.botUser.username,
			firstName: this.botUser.firstName,
		};
	}

	async fetchUpdates(
		offset = 0,
		limit = 100,
	): Promise<{ updates: TelegramUpdate[]; nextOffset: number }> {
		const filtered = this.updatesQueue.filter((u) => u.update_id >= offset).slice(0, limit);
		const maxUpdateId = filtered.reduce((max, u) => Math.max(max, u.update_id), offset - 1);
		return {
			updates: filtered,
			nextOffset: maxUpdateId >= offset ? maxUpdateId + 1 : offset,
		};
	}

	async sendMessage(
		chatId: string | number,
		text: string,
		replyToMessageId?: string | number,
	): Promise<{ messageId: string | number }> {
		this.currentMessageId += 1;
		const messageId = this.currentMessageId;
		this.sentMessages.push({
			chatId,
			text,
			...(replyToMessageId !== undefined ? { replyToMessageId } : {}),
			messageId,
		});
		return { messageId };
	}
}

export class HttpTelegramBotClient implements TelegramClientInterface {
	private botToken: string;
	private apiBaseUrl: string;

	constructor(botToken: string, apiBaseUrl = "https://api.telegram.org") {
		this.botToken = botToken;
		this.apiBaseUrl = apiBaseUrl.replace(/\/+$/, "");
	}

	private getEndpoint(method: string): string {
		return `${this.apiBaseUrl}/bot${this.botToken}/${method}`;
	}

	async getMe(): Promise<{ id: number; username?: string; firstName: string }> {
		const res = await fetch(this.getEndpoint("getMe"), {
			headers: { Accept: "application/json" },
		});
		const json = (await res.json()) as {
			ok: boolean;
			result?: { id: number; username?: string; first_name: string };
			description?: string;
		};
		if (!json.ok || !json.result) {
			throw new Error(`Telegram getMe error: ${json.description ?? res.statusText}`);
		}
		return {
			id: json.result.id,
			...(json.result.username ? { username: json.result.username } : {}),
			firstName: json.result.first_name,
		};
	}

	async fetchUpdates(
		offset = 0,
		limit = 100,
	): Promise<{ updates: TelegramUpdate[]; nextOffset: number }> {
		const url = new URL(this.getEndpoint("getUpdates"));
		if (offset > 0) url.searchParams.set("offset", String(offset));
		url.searchParams.set("limit", String(limit));
		url.searchParams.set("timeout", "5");

		const res = await fetch(url.toString(), {
			headers: { Accept: "application/json" },
		});
		const json = (await res.json()) as {
			ok: boolean;
			result?: TelegramUpdate[];
			description?: string;
		};
		if (!json.ok || !Array.isArray(json.result)) {
			throw new Error(`Telegram getUpdates error: ${json.description ?? res.statusText}`);
		}

		const updates = json.result;
		const maxUpdateId = updates.reduce((max, u) => Math.max(max, u.update_id), offset - 1);
		return {
			updates,
			nextOffset: maxUpdateId >= offset ? maxUpdateId + 1 : offset,
		};
	}

	async sendMessage(
		chatId: string | number,
		text: string,
		replyToMessageId?: string | number,
	): Promise<{ messageId: string | number }> {
		const payload: Record<string, unknown> = {
			chat_id: chatId,
			text,
		};
		if (replyToMessageId !== undefined) {
			payload.reply_to_message_id = replyToMessageId;
		}

		const res = await fetch(this.getEndpoint("sendMessage"), {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify(payload),
		});

		const json = (await res.json()) as {
			ok: boolean;
			result?: { message_id: number };
			description?: string;
		};
		if (!json.ok || !json.result) {
			throw new Error(`Telegram sendMessage error: ${json.description ?? res.statusText}`);
		}

		return { messageId: json.result.message_id };
	}
}

// ---------------------------------------------------------------------------
// Telegram Connector Core Service
// ---------------------------------------------------------------------------

export class TelegramConnector {
	private config: TelegramAccountConfig;
	private customClient?: TelegramClientInterface;
	private lastUpdateOffset = 0;

	constructor(config: TelegramAccountConfig, client?: TelegramClientInterface) {
		this.config = config;
		if (client) this.customClient = client;
	}

	private getClient(): TelegramClientInterface {
		if (this.customClient) return this.customClient;
		const token = this.config.bot?.botToken;
		if (!token) {
			throw new Error(`Telegram account ${this.config.id} is missing bot token`);
		}
		return new HttpTelegramBotClient(token, this.config.bot?.apiBaseUrl);
	}

	async sync(
		_options: { force?: boolean } = {},
		database?: Database,
	): Promise<{ syncedCount: number; unreadCount: number }> {
		const db = database ?? getHubDb();
		const client = this.getClient();

		try {
			const { updates, nextOffset } = await client.fetchUpdates(this.lastUpdateOffset, 100);
			this.lastUpdateOffset = nextOffset;

			const incomingMessages: Array<Omit<HubMessage, "id">> = [];

			for (const update of updates) {
				const raw = update.message ?? update.channel_post ?? update.edited_message;
				if (!raw) continue;

				const text = (raw.text ?? raw.caption ?? "").trim();
				if (!text) continue;

				const chatId = String(raw.chat.id);
				const nameParts = [raw.chat.first_name, raw.chat.last_name].filter(Boolean).join(" ");
				const chatTitle =
					raw.chat.title ??
					(nameParts || (raw.chat.username ? `@${raw.chat.username}` : `Chat ${chatId}`));

				// Save/update channel representation
				const channelKind =
					raw.chat.type === "channel" ? "channel" : raw.chat.type === "private" ? "dm" : "group";
				const channel: HubChannel = {
					id: `tg-${chatId}`,
					accountId: this.config.id,
					remoteId: chatId,
					name: chatTitle,
					kind: channelKind,
					unreadCount: 0,
					lastMessageAt: raw.date * 1000,
				};
				saveChannel(channel, db);

				const senderName = raw.from
					? [raw.from.first_name, raw.from.last_name].filter(Boolean).join(" ") ||
						raw.from.username ||
						`User ${raw.from.id}`
					: chatTitle;

				const senderAddress = raw.from?.username
					? `@${raw.from.username}`
					: raw.from
						? String(raw.from.id)
						: chatId;

				const timestamp = raw.date * 1000;
				const snippet = generateMessageSnippet(text);
				const isUrgent = detectMessageUrgency(undefined, text);

				incomingMessages.push({
					accountId: this.config.id,
					remoteId: String(raw.message_id),
					channelId: channel.id,
					senderName,
					senderAddress,
					body: text,
					snippet,
					timestamp,
					isRead: false,
					isUrgent,
					hasAttachments: false,
					metadata: {
						chatId,
						chatType: raw.chat.type,
						...(raw.reply_to_message
							? { replyToMessageId: String(raw.reply_to_message.message_id) }
							: {}),
					},
				});
			}

			const { inserted, updated } = saveIncomingMessages(incomingMessages, undefined, db);

			for (const msg of inserted) {
				publishHubMessage(msg);
			}

			const unreadRow = db
				.query("SELECT COUNT(*) as count FROM hub_messages WHERE account_id = ? AND is_read = 0;")
				.get(this.config.id) as { count: number } | null;
			const totalUnread = unreadRow?.count ?? 0;

			updateAccountStatus(this.config.id, "connected", totalUnread, null, db);
			publishHubAccountStatus({
				accountId: this.config.id,
				status: "connected",
				unreadCount: totalUnread,
			});

			return {
				syncedCount: inserted.length + updated.length,
				unreadCount: totalUnread,
			};
		} catch (err: unknown) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			log.error(`Telegram sync error for ${this.config.id}: ${errorMsg}`);
			const existing = getAccount(this.config.id, db);
			const currentUnread = existing?.unreadCount ?? 0;
			updateAccountStatus(this.config.id, "error", currentUnread, errorMsg, db);
			publishHubAccountStatus({
				accountId: this.config.id,
				status: "error",
				unreadCount: currentUnread,
			});
			throw err;
		}
	}

	async send(params: HubSendMessageParams, database?: Database): Promise<HubSendMessageResult> {
		const db = database ?? getHubDb();
		const client = this.getClient();

		try {
			// Resolve recipient: channel remote ID, chatId from metadata or recipient field
			let targetChatId = params.recipient;
			if (params.channelId?.startsWith("tg-")) {
				targetChatId = params.channelId.slice(3);
			}

			const sendRes = await client.sendMessage(targetChatId, params.body, params.replyToMessageId);

			const id = randomUUID();
			const message: HubMessage = {
				id,
				accountId: this.config.id,
				remoteId: String(sendRes.messageId),
				...(params.channelId ? { channelId: params.channelId } : {}),
				senderName: this.config.name,
				senderAddress: `bot:${this.config.id}`,
				recipientAddress: String(targetChatId),
				body: params.body,
				snippet: generateMessageSnippet(params.body),
				timestamp: Date.now(),
				isRead: true,
				isUrgent: false,
				hasAttachments: false,
				...(params.replyToMessageId
					? { metadata: { replyToMessageId: params.replyToMessageId } }
					: {}),
			};

			saveMessage(message, db);
			publishHubMessage(message);

			return {
				success: true,
				messageId: id,
			};
		} catch (err: unknown) {
			const error = err instanceof Error ? err.message : String(err);
			log.error(`Telegram send error for ${this.config.id}: ${error}`);
			return {
				success: false,
				error,
			};
		}
	}
}

// ---------------------------------------------------------------------------
// Registration & Integration Helpers
// ---------------------------------------------------------------------------

export function registerTelegramAccount(
	config: TelegramAccountConfig,
	client?: TelegramClientInterface,
): TelegramConnector {
	const connector = new TelegramConnector(config, client);

	registerHubAccountSyncer(config.id, async (_params) => {
		try {
			await connector.sync();
			return {
				synced: true,
				accountIds: [config.id],
			};
		} catch (err: unknown) {
			return {
				synced: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	});

	registerHubMessageSender(config.id, async (params) => {
		return connector.send(params);
	});

	return connector;
}
