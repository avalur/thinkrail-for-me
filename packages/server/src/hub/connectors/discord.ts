import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type {
	HubAttachment,
	HubChannel,
	HubMessage,
	HubSendMessageParams,
	HubSendMessageResult,
} from "@thinkrail/contracts";
import { logger } from "../../log";
import type { DiscordAccountConfig } from "../accounts";
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

const log = logger("hub:discord");

// ---------------------------------------------------------------------------
// Discord Domain Types
// ---------------------------------------------------------------------------

export interface DiscordUser {
	id: string;
	username: string;
	global_name?: string | null;
	discriminator?: string;
	bot?: boolean;
	avatar?: string | null;
}

export interface DiscordChannel {
	id: string;
	name?: string;
	type: number; // 0: GUILD_TEXT, 1: DM, 2: GUILD_VOICE, 3: GROUP_DM, 5: GUILD_ANNOUNCEMENT
	guild_id?: string;
	topic?: string;
}

export interface DiscordAttachment {
	id: string;
	filename: string;
	size: number;
	url: string;
	content_type?: string;
}

export interface DiscordMessage {
	id: string;
	channel_id: string;
	author: DiscordUser;
	content: string;
	timestamp: string; // ISO 8601 string
	edited_timestamp?: string | null;
	referenced_message?: { id: string } | null;
	attachments?: DiscordAttachment[];
}

// ---------------------------------------------------------------------------
// Discord Client Interface & Implementations
// ---------------------------------------------------------------------------

export interface DiscordClientInterface {
	getCurrentUser(): Promise<DiscordUser>;
	getGuildChannels(guildId: string): Promise<DiscordChannel[]>;
	getChannelMessages(channelId: string, after?: string, limit?: number): Promise<DiscordMessage[]>;
	sendMessage(
		channelId: string,
		content: string,
		replyToMessageId?: string,
	): Promise<{ id: string; channel_id: string }>;
	sendWebhookMessage?(webhookUrl: string, content: string): Promise<{ id: string }>;
}

export class MockDiscordClient implements DiscordClientInterface {
	public channels: DiscordChannel[] = [];
	public messagesQueue: DiscordMessage[] = [];
	public sentMessages: Array<{
		channelId: string;
		content: string;
		replyToMessageId?: string;
		id: string;
	}> = [];
	public currentUser: DiscordUser = {
		id: "U_DISCORD_BOT",
		username: "ThinkRailBot",
		global_name: "ThinkRail Bot",
		bot: true,
	};
	private currentMessageIdCounter = 9000;

	constructor(channels: DiscordChannel[] = [], messages: DiscordMessage[] = []) {
		this.channels = [...channels];
		this.messagesQueue = [...messages];
	}

	async getCurrentUser(): Promise<DiscordUser> {
		return { ...this.currentUser };
	}

	async getGuildChannels(_guildId: string): Promise<DiscordChannel[]> {
		return [...this.channels];
	}

	async getChannelMessages(
		channelId: string,
		after?: string,
		limit = 50,
	): Promise<DiscordMessage[]> {
		const afterNum = after ? BigInt(after) : 0n;
		return this.messagesQueue
			.filter((m) => m.channel_id === channelId && BigInt(m.id) > afterNum)
			.slice(0, limit);
	}

	async sendMessage(
		channelId: string,
		content: string,
		replyToMessageId?: string,
	): Promise<{ id: string; channel_id: string }> {
		this.currentMessageIdCounter += 1;
		const id = String(this.currentMessageIdCounter);
		this.sentMessages.push({
			channelId,
			content,
			...(replyToMessageId ? { replyToMessageId } : {}),
			id,
		});
		return { id, channel_id: channelId };
	}

	async sendWebhookMessage(webhookUrl: string, content: string): Promise<{ id: string }> {
		this.currentMessageIdCounter += 1;
		const id = String(this.currentMessageIdCounter);
		this.sentMessages.push({
			channelId: webhookUrl,
			content,
			id,
		});
		return { id };
	}
}

export class HttpDiscordClient implements DiscordClientInterface {
	private botToken?: string | undefined;
	private apiBaseUrl: string;

	constructor(botToken?: string, apiBaseUrl = "https://discord.com/api/v10") {
		this.botToken = botToken;
		this.apiBaseUrl = apiBaseUrl.replace(/\/+$/, "");
	}

	private async request<T>(
		endpoint: string,
		options: {
			method?: string;
			body?: Record<string, unknown>;
			query?: Record<string, string>;
		} = {},
	): Promise<T> {
		const url = new URL(`${this.apiBaseUrl}/${endpoint.replace(/^\/+/, "")}`);
		if (options.query) {
			for (const [k, v] of Object.entries(options.query)) {
				url.searchParams.set(k, v);
			}
		}

		const headers: Record<string, string> = {
			Accept: "application/json",
		};
		if (this.botToken) {
			headers.Authorization = `Bot ${this.botToken}`;
		}
		if (options.body) {
			headers["Content-Type"] = "application/json";
		}

		const fetchInit: RequestInit = {
			method: options.method ?? (options.body ? "POST" : "GET"),
			headers,
		};
		if (options.body) {
			fetchInit.body = JSON.stringify(options.body);
		}

		const res = await fetch(url.toString(), fetchInit);

		if (!res.ok) {
			let errorText = res.statusText;
			try {
				const errJson = (await res.json()) as { message?: string };
				if (errJson.message) errorText = errJson.message;
			} catch {
				// use statusText
			}
			throw new Error(`Discord API error (${endpoint}): ${errorText}`);
		}

		return (await res.json()) as T;
	}

	async getCurrentUser(): Promise<DiscordUser> {
		return this.request<DiscordUser>("users/@me");
	}

	async getGuildChannels(guildId: string): Promise<DiscordChannel[]> {
		return this.request<DiscordChannel[]>(`guilds/${guildId}/channels`);
	}

	async getChannelMessages(
		channelId: string,
		after?: string,
		limit = 50,
	): Promise<DiscordMessage[]> {
		const query: Record<string, string> = {
			limit: String(limit),
		};
		if (after) {
			query.after = after;
		}
		return this.request<DiscordMessage[]>(`channels/${channelId}/messages`, { query });
	}

	async sendMessage(
		channelId: string,
		content: string,
		replyToMessageId?: string,
	): Promise<{ id: string; channel_id: string }> {
		const body: Record<string, unknown> = { content };
		if (replyToMessageId) {
			body.message_reference = { message_id: replyToMessageId };
		}
		return this.request<{ id: string; channel_id: string }>(`channels/${channelId}/messages`, {
			method: "POST",
			body,
		});
	}

	async sendWebhookMessage(webhookUrl: string, content: string): Promise<{ id: string }> {
		const res = await fetch(`${webhookUrl}?wait=true`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Accept: "application/json" },
			body: JSON.stringify({ content }),
		});
		if (!res.ok) {
			throw new Error(`Discord webhook error: ${res.statusText}`);
		}
		const json = (await res.json()) as { id: string };
		return { id: json.id };
	}
}

// ---------------------------------------------------------------------------
// Discord Connector Core Service
// ---------------------------------------------------------------------------

export class DiscordConnector {
	private config: DiscordAccountConfig;
	private customClient?: DiscordClientInterface;
	private lastSyncMessageIds = new Map<string, string>();

	constructor(config: DiscordAccountConfig, client?: DiscordClientInterface) {
		this.config = config;
		if (client) this.customClient = client;
	}

	private getClient(): DiscordClientInterface {
		if (this.customClient) return this.customClient;
		return new HttpDiscordClient(this.config.botToken, this.config.apiBaseUrl);
	}

	async sync(
		_options: { force?: boolean } = {},
		database?: Database,
	): Promise<{ syncedCount: number; unreadCount: number }> {
		const db = database ?? getHubDb();
		const client = this.getClient();

		try {
			// 1. Identify channels
			let channels: DiscordChannel[] = [];
			if (this.config.channelIds && this.config.channelIds.length > 0) {
				channels = this.config.channelIds.map((cid) => ({
					id: cid,
					name: cid,
					type: 0,
				}));
			} else if (this.config.guildId) {
				const guildChannels = await client.getGuildChannels(this.config.guildId);
				// Filter for text (0) and announcement (5) channels
				channels = guildChannels.filter((c) => c.type === 0 || c.type === 5);
			}

			const incomingMessages: Array<Omit<HubMessage, "id">> = [];

			for (const ch of channels) {
				const channelKind = ch.type === 1 || ch.type === 3 ? "dm" : "channel";
				const channelName = ch.name
					? ch.name.startsWith("#")
						? ch.name
						: `#${ch.name}`
					: `#channel-${ch.id}`;

				const hubChannel: HubChannel = {
					id: `discord-${ch.id}`,
					accountId: this.config.id,
					remoteId: ch.id,
					name: channelName,
					kind: channelKind,
					unreadCount: 0,
				};
				saveChannel(hubChannel, db);

				const after = this.lastSyncMessageIds.get(ch.id);
				const messages = await client.getChannelMessages(ch.id, after, 50);

				let maxId = after;
				for (const msg of messages) {
					if (!msg.content && (!msg.attachments || msg.attachments.length === 0)) continue;

					if (!maxId || BigInt(msg.id) > BigInt(maxId)) {
						maxId = msg.id;
					}

					const timestamp = new Date(msg.timestamp).getTime();
					const text = msg.content ? msg.content.trim() : "(attachment)";
					const snippet = generateMessageSnippet(text);
					const isUrgent = detectMessageUrgency(undefined, text);

					const senderName = msg.author.global_name || msg.author.username;
					const senderAddress = `@${msg.author.username}`;

					const attachments: HubAttachment[] = (msg.attachments ?? []).map((att) => ({
						id: att.id,
						name: att.filename,
						size: att.size,
						url: att.url,
						...(att.content_type ? { mimeType: att.content_type } : {}),
					}));

					incomingMessages.push({
						accountId: this.config.id,
						remoteId: `${ch.id}:${msg.id}`,
						channelId: hubChannel.id,
						senderName,
						senderAddress,
						recipientAddress: channelName,
						body: text,
						snippet,
						timestamp,
						isRead: false,
						isUrgent,
						hasAttachments: attachments.length > 0,
						...(attachments.length > 0 ? { attachments } : {}),
						metadata: {
							channelId: ch.id,
							messageId: msg.id,
							authorId: msg.author.id,
							...(msg.referenced_message ? { replyToMessageId: msg.referenced_message.id } : {}),
						},
					});
				}

				if (maxId) {
					this.lastSyncMessageIds.set(ch.id, maxId);
				}
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
			log.error(`Discord sync error for ${this.config.id}: ${errorMsg}`);
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
			let targetChannel = params.recipient;
			if (params.channelId?.startsWith("discord-")) {
				targetChannel = params.channelId.slice(8);
			} else if (params.channelId) {
				targetChannel = params.channelId;
			}

			let remoteMessageId: string;
			if (this.config.webhookUrl && !this.config.botToken && client.sendWebhookMessage) {
				const res = await client.sendWebhookMessage(this.config.webhookUrl, params.body);
				remoteMessageId = res.id;
			} else {
				const res = await client.sendMessage(targetChannel, params.body, params.replyToMessageId);
				remoteMessageId = res.id;
			}

			const id = randomUUID();
			const message: HubMessage = {
				id,
				accountId: this.config.id,
				remoteId: `${targetChannel}:${remoteMessageId}`,
				...(params.channelId ? { channelId: params.channelId } : {}),
				senderName: this.config.name,
				senderAddress: `bot:${this.config.id}`,
				recipientAddress: targetChannel,
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
			log.error(`Discord send error for ${this.config.id}: ${error}`);
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

export function registerDiscordAccount(
	config: DiscordAccountConfig,
	client?: DiscordClientInterface,
): DiscordConnector {
	const connector = new DiscordConnector(config, client);

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
