import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type {
	HubChannel,
	HubMessage,
	HubSendMessageParams,
	HubSendMessageResult,
} from "@thinkrail/contracts";
import { logger } from "../../log";
import type { SlackAccountConfig } from "../accounts";
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

const log = logger("hub:slack");

// ---------------------------------------------------------------------------
// Slack Domain Types
// ---------------------------------------------------------------------------

export interface SlackConversation {
	id: string;
	name?: string;
	is_channel?: boolean;
	is_group?: boolean;
	is_im?: boolean;
	is_private?: boolean;
	user?: string;
	topic?: { value: string };
	purpose?: { value: string };
}

export interface SlackMessage {
	ts: string;
	user?: string;
	username?: string;
	bot_id?: string;
	text: string;
	thread_ts?: string;
	channel?: string;
	reply_count?: number;
}

export interface SlackAuthTestResponse {
	ok: boolean;
	user_id?: string;
	bot_id?: string;
	user?: string;
	team?: string;
	error?: string;
}

// ---------------------------------------------------------------------------
// Slack Client Interface & Implementations
// ---------------------------------------------------------------------------

export interface SlackClientInterface {
	authTest(): Promise<{ userId: string; botId?: string; user: string; team: string }>;
	listConversations(types?: string): Promise<SlackConversation[]>;
	fetchHistory(channelId: string, oldest?: string, limit?: number): Promise<SlackMessage[]>;
	postMessage(
		channelId: string,
		text: string,
		threadTs?: string,
	): Promise<{ ok: boolean; ts: string }>;
}

export class MockSlackClient implements SlackClientInterface {
	public conversations: SlackConversation[] = [];
	public messagesQueue: SlackMessage[] = [];
	public sentMessages: Array<{
		channelId: string;
		text: string;
		threadTs?: string;
		ts: string;
	}> = [];
	public botUser = {
		userId: "U_SLACK_BOT",
		botId: "B_SLACK_BOT",
		user: "thinkrail_bot",
		team: "ThinkRail Team",
	};
	private currentTsCounter = 1710000000;

	constructor(conversations: SlackConversation[] = [], messages: SlackMessage[] = []) {
		this.conversations = [...conversations];
		this.messagesQueue = [...messages];
	}

	async authTest(): Promise<{ userId: string; botId?: string; user: string; team: string }> {
		return { ...this.botUser };
	}

	async listConversations(_types?: string): Promise<SlackConversation[]> {
		return [...this.conversations];
	}

	async fetchHistory(channelId: string, oldest?: string, limit = 100): Promise<SlackMessage[]> {
		const oldestNum = oldest ? parseFloat(oldest) : 0;
		return this.messagesQueue
			.filter((m) => (!m.channel || m.channel === channelId) && parseFloat(m.ts) > oldestNum)
			.slice(0, limit);
	}

	async postMessage(
		channelId: string,
		text: string,
		threadTs?: string,
	): Promise<{ ok: boolean; ts: string }> {
		this.currentTsCounter += 1;
		const ts = `${this.currentTsCounter}.000100`;
		this.sentMessages.push({
			channelId,
			text,
			...(threadTs ? { threadTs } : {}),
			ts,
		});
		return { ok: true, ts };
	}
}

export class HttpSlackClient implements SlackClientInterface {
	private token: string;
	private apiBaseUrl: string;

	constructor(token: string, apiBaseUrl = "https://slack.com/api") {
		this.token = token;
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
			Authorization: `Bearer ${this.token}`,
			Accept: "application/json",
		};
		if (options.body) {
			headers["Content-Type"] = "application/json; charset=utf-8";
		}

		const fetchInit: RequestInit = {
			method: options.method ?? (options.body ? "POST" : "GET"),
			headers,
		};
		if (options.body) {
			fetchInit.body = JSON.stringify(options.body);
		}

		const res = await fetch(url.toString(), fetchInit);

		const json = (await res.json()) as { ok: boolean; error?: string };
		if (!json.ok) {
			throw new Error(`Slack API error (${endpoint}): ${json.error ?? res.statusText}`);
		}
		return json as T;
	}

	async authTest(): Promise<{ userId: string; botId?: string; user: string; team: string }> {
		const json = await this.request<SlackAuthTestResponse>("auth.test", { method: "POST" });
		return {
			userId: json.user_id ?? "unknown",
			...(json.bot_id ? { botId: json.bot_id } : {}),
			user: json.user ?? "bot",
			team: json.team ?? "slack",
		};
	}

	async listConversations(
		types = "public_channel,private_channel,im,mpim",
	): Promise<SlackConversation[]> {
		const json = await this.request<{ ok: boolean; channels?: SlackConversation[] }>(
			"conversations.list",
			{ query: { types, limit: "100" } },
		);
		return json.channels ?? [];
	}

	async fetchHistory(channelId: string, oldest?: string, limit = 50): Promise<SlackMessage[]> {
		const query: Record<string, string> = {
			channel: channelId,
			limit: String(limit),
		};
		if (oldest) {
			query.oldest = oldest;
		}

		const json = await this.request<{ ok: boolean; messages?: SlackMessage[] }>(
			"conversations.history",
			{ query },
		);
		return json.messages ?? [];
	}

	async postMessage(
		channelId: string,
		text: string,
		threadTs?: string,
	): Promise<{ ok: boolean; ts: string }> {
		const body: Record<string, unknown> = {
			channel: channelId,
			text,
		};
		if (threadTs) {
			body.thread_ts = threadTs;
		}

		const json = await this.request<{ ok: boolean; ts: string }>("chat.postMessage", {
			method: "POST",
			body,
		});
		return { ok: true, ts: json.ts };
	}
}

// ---------------------------------------------------------------------------
// Slack Connector Core Service
// ---------------------------------------------------------------------------

export class SlackConnector {
	private config: SlackAccountConfig;
	private customClient?: SlackClientInterface;
	private lastSyncTimestamps = new Map<string, string>();

	constructor(config: SlackAccountConfig, client?: SlackClientInterface) {
		this.config = config;
		if (client) this.customClient = client;
	}

	private getClient(): SlackClientInterface {
		if (this.customClient) return this.customClient;
		const token = this.config.botToken ?? this.config.userToken;
		if (!token) {
			throw new Error(`Slack account ${this.config.id} is missing botToken or userToken`);
		}
		return new HttpSlackClient(token, this.config.apiBaseUrl);
	}

	async sync(
		_options: { force?: boolean } = {},
		database?: Database,
	): Promise<{ syncedCount: number; unreadCount: number }> {
		const db = database ?? getHubDb();
		const client = this.getClient();

		try {
			// 1. Identify channels to sync
			let conversations: SlackConversation[] = [];
			if (this.config.channelIds && this.config.channelIds.length > 0) {
				conversations = this.config.channelIds.map((cid) => ({
					id: cid,
					name: cid,
					is_channel: true,
				}));
			} else {
				conversations = await client.listConversations();
			}

			const incomingMessages: Array<Omit<HubMessage, "id">> = [];

			for (const conv of conversations) {
				const channelKind = conv.is_im ? "dm" : "channel";
				const channelName = conv.name
					? conv.name.startsWith("#")
						? conv.name
						: `#${conv.name}`
					: conv.is_im
						? conv.user
							? `@${conv.user}`
							: `@im-${conv.id}`
						: conv.id;

				const channel: HubChannel = {
					id: `slack-${conv.id}`,
					accountId: this.config.id,
					remoteId: conv.id,
					name: channelName,
					kind: channelKind,
					unreadCount: 0,
				};
				saveChannel(channel, db);

				const oldest = this.lastSyncTimestamps.get(conv.id);
				const messages = await client.fetchHistory(conv.id, oldest, 50);

				let maxTs = oldest;
				for (const msg of messages) {
					if (!msg.text || !msg.ts) continue;

					if (!maxTs || parseFloat(msg.ts) > parseFloat(maxTs)) {
						maxTs = msg.ts;
					}

					const timestamp = Math.floor(parseFloat(msg.ts) * 1000);
					const text = msg.text.trim();
					const snippet = generateMessageSnippet(text);
					const isUrgent = detectMessageUrgency(undefined, text);

					const senderName = msg.username || (msg.user ? `@${msg.user}` : "Slack User");
					const senderAddress = msg.user ? `@${msg.user}` : "slack";

					incomingMessages.push({
						accountId: this.config.id,
						remoteId: `${conv.id}:${msg.ts}`,
						channelId: channel.id,
						senderName,
						senderAddress,
						recipientAddress: channelName,
						body: text,
						snippet,
						timestamp,
						isRead: false,
						isUrgent,
						hasAttachments: false,
						metadata: {
							channelId: conv.id,
							ts: msg.ts,
							...(msg.thread_ts ? { threadTs: msg.thread_ts } : {}),
						},
					});
				}

				if (maxTs) {
					this.lastSyncTimestamps.set(conv.id, maxTs);
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
			log.error(`Slack sync error for ${this.config.id}: ${errorMsg}`);
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
			if (params.channelId?.startsWith("slack-")) {
				targetChannel = params.channelId.slice(6);
			} else if (params.channelId) {
				targetChannel = params.channelId;
			}

			const sendRes = await client.postMessage(targetChannel, params.body, params.replyToMessageId);

			const id = randomUUID();
			const message: HubMessage = {
				id,
				accountId: this.config.id,
				remoteId: `${targetChannel}:${sendRes.ts}`,
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
				...(params.replyToMessageId ? { metadata: { threadTs: params.replyToMessageId } } : {}),
			};

			saveMessage(message, db);
			publishHubMessage(message);

			return {
				success: true,
				messageId: id,
			};
		} catch (err: unknown) {
			const error = err instanceof Error ? err.message : String(err);
			log.error(`Slack send error for ${this.config.id}: ${error}`);
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

export function registerSlackAccount(
	config: SlackAccountConfig,
	client?: SlackClientInterface,
): SlackConnector {
	const connector = new SlackConnector(config, client);

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
