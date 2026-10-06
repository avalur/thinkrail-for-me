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
	getChannel,
	getHubDb,
	saveAccount,
	saveChannel,
	saveIncomingMessage,
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
	recipients?: DiscordUser[];
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

export interface DiscordGetMessagesOptions {
	after?: string | undefined;
	before?: string | undefined;
	limit?: number | undefined;
}

export interface DiscordClientInterface {
	getCurrentUser(): Promise<DiscordUser>;
	getUserGuilds?(): Promise<Array<{ id: string; name: string }>>;
	getUserChannels?(): Promise<DiscordChannel[]>;
	getGuildChannels(guildId: string): Promise<DiscordChannel[]>;
	getChannelMessages(
		channelId: string,
		optionsOrAfter?: string | DiscordGetMessagesOptions,
		limit?: number,
	): Promise<DiscordMessage[]>;
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

	async getUserGuilds(): Promise<Array<{ id: string; name: string }>> {
		return [{ id: "G_123456", name: "Mock Guild" }];
	}

	async getUserChannels(): Promise<DiscordChannel[]> {
		return [];
	}

	async getGuildChannels(_guildId: string): Promise<DiscordChannel[]> {
		return [...this.channels];
	}

	async getChannelMessages(
		channelId: string,
		optionsOrAfter?: string | DiscordGetMessagesOptions,
		limit = 50,
	): Promise<DiscordMessage[]> {
		let afterNum = 0n;
		let beforeNum = 0n;
		let lim = limit;
		if (typeof optionsOrAfter === "string") {
			afterNum = optionsOrAfter ? BigInt(optionsOrAfter) : 0n;
		} else if (optionsOrAfter) {
			if (optionsOrAfter.after) afterNum = BigInt(optionsOrAfter.after);
			if (optionsOrAfter.before) beforeNum = BigInt(optionsOrAfter.before);
			if (optionsOrAfter.limit) lim = optionsOrAfter.limit;
		}

		return this.messagesQueue
			.filter((m) => {
				if (m.channel_id !== channelId) return false;
				const idBig = BigInt(m.id);
				if (afterNum && idBig <= afterNum) return false;
				if (beforeNum && idBig >= beforeNum) return false;
				return true;
			})
			.slice(0, lim);
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
	private token?: string | undefined;
	private isUserToken: boolean;
	private apiBaseUrl: string;

	constructor(token?: string, apiBaseUrl = "https://discord.com/api/v10", isUserToken = false) {
		this.token = token;
		this.isUserToken = isUserToken;
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
		if (this.token) {
			const trimmed = this.token.trim();
			if (trimmed.startsWith("Bot ")) {
				headers.Authorization = trimmed;
			} else if (this.isUserToken) {
				headers.Authorization = trimmed;
			} else {
				headers.Authorization = `Bot ${trimmed}`;
			}
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

	async getUserGuilds(): Promise<Array<{ id: string; name: string }>> {
		return this.request<Array<{ id: string; name: string }>>("users/@me/guilds");
	}

	async getUserChannels(): Promise<DiscordChannel[]> {
		return this.request<DiscordChannel[]>("users/@me/channels");
	}

	async getGuildChannels(guildId: string): Promise<DiscordChannel[]> {
		return this.request<DiscordChannel[]>(`guilds/${guildId}/channels`);
	}

	async getChannelMessages(
		channelId: string,
		optionsOrAfter?: string | DiscordGetMessagesOptions,
		limit = 50,
	): Promise<DiscordMessage[]> {
		const query: Record<string, string> = {};
		if (typeof optionsOrAfter === "string") {
			if (optionsOrAfter) query.after = optionsOrAfter;
			query.limit = String(limit);
		} else if (optionsOrAfter) {
			if (optionsOrAfter.after) query.after = optionsOrAfter.after;
			if (optionsOrAfter.before) query.before = optionsOrAfter.before;
			query.limit = String(optionsOrAfter.limit ?? limit);
		} else {
			query.limit = String(limit);
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
// Discord Gateway Client (WebSocket Realtime)
// ---------------------------------------------------------------------------

export class DiscordGatewayClient {
	private token: string;
	private ws: WebSocket | null = null;
	private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
	private lastSequence: number | null = null;
	private stopped = false;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private onMessageCreate: (msg: DiscordMessage) => void;

	constructor(token: string, onMessageCreate: (msg: DiscordMessage) => void) {
		this.token = token;
		this.onMessageCreate = onMessageCreate;
	}

	start(): void {
		if (this.stopped) return;
		try {
			this.ws = new WebSocket("wss://gateway.discord.gg/?v=10&encoding=json");

			this.ws.onopen = () => {
				log.info("Discord Gateway WebSocket connected");
			};

			this.ws.onmessage = (event) => {
				try {
					const data = JSON.parse(String(event.data)) as {
						op: number;
						d: unknown;
						s?: number | null;
						t?: string | null;
					};

					if (data.s !== undefined && data.s !== null) {
						this.lastSequence = data.s;
					}

					if (data.op === 10) {
						// Hello - setup heartbeat
						const d = data.d as { heartbeat_interval?: number };
						const heartbeatInterval = d?.heartbeat_interval ?? 41250;
						if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
						this.heartbeatTimer = setInterval(() => {
							const socket = this.ws;
							if (socket && socket.readyState === WebSocket.OPEN) {
								socket.send(JSON.stringify({ op: 1, d: this.lastSequence }));
							}
						}, heartbeatInterval);

						// Send Identify (Opcode 2)
						// Intents: GUILDS (1) + GUILD_MESSAGES (512) + MESSAGE_CONTENT (32768) + DIRECT_MESSAGES (4096)
						const intents = 1 | 512 | 32768 | 4096;
						const trimmed = this.token.trim().replace(/^Bot\s+/i, "");
						const socket = this.ws;
						if (socket && socket.readyState === WebSocket.OPEN) {
							socket.send(
								JSON.stringify({
									op: 2,
									d: {
										token: trimmed,
										intents,
										properties: {
											os: "darwin",
											browser: "thinkrail",
											device: "thinkrail",
										},
									},
								}),
							);
						}
					} else if (data.op === 0 && data.t === "MESSAGE_CREATE") {
						const msg = data.d as DiscordMessage;
						if (msg) {
							this.onMessageCreate(msg);
						}
					}
				} catch (err) {
					log.warn(`Error handling Gateway message: ${err}`);
				}
			};

			this.ws.onerror = (err) => {
				log.warn(`Discord Gateway error: ${err}`);
			};

			this.ws.onclose = () => {
				if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
				if (!this.stopped) {
					this.reconnectTimer = setTimeout(() => this.start(), 5000);
				}
			};
		} catch (e) {
			log.warn(`Could not connect to Discord Gateway: ${e}`);
		}
	}

	stop(): void {
		this.stopped = true;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
		if (this.ws) {
			try {
				this.ws.close();
			} catch {}
			this.ws = null;
		}
	}
}

// ---------------------------------------------------------------------------
// Discord Connector Core Service
// ---------------------------------------------------------------------------

export class DiscordConnector {
	private config: DiscordAccountConfig;
	private customClient?: DiscordClientInterface;
	private lastSyncMessageIds = new Map<string, string>();
	private gatewayClient: DiscordGatewayClient | null = null;

	constructor(config: DiscordAccountConfig, client?: DiscordClientInterface) {
		this.config = config;
		if (client) this.customClient = client;
	}

	stop(): void {
		if (this.gatewayClient) {
			this.gatewayClient.stop();
			this.gatewayClient = null;
		}
	}

	private getBotToken(): string | undefined {
		return this.config.botToken || process.env.DISCORD_BOT_TOKEN;
	}

	private getUserToken(): string | undefined {
		return this.config.userToken || process.env.DISCORD_USER_TOKEN;
	}

	private getTokenInfo(): { token: string; isUser: boolean } | undefined {
		const userToken = this.getUserToken();
		if (userToken) {
			return { token: userToken, isUser: true };
		}
		const botToken = this.getBotToken();
		if (botToken) {
			return { token: botToken, isUser: false };
		}
		return undefined;
	}

	private getGuildId(): string | undefined {
		return this.config.guildId || process.env.DISCORD_GUILD_ID;
	}

	private getWebhookUrl(): string | undefined {
		return this.config.webhookUrl || process.env.DISCORD_WEBHOOK_URL;
	}

	private getChannelIds(): string[] | undefined {
		if (this.config.channelIds && this.config.channelIds.length > 0) {
			return this.config.channelIds;
		}
		const env = process.env.DISCORD_CHANNEL_IDS;
		return env
			? env
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean)
			: undefined;
	}

	private getClient(): DiscordClientInterface {
		if (this.customClient) return this.customClient;
		const tokenInfo = this.getTokenInfo();
		return new HttpDiscordClient(
			tokenInfo?.token,
			this.config.apiBaseUrl,
			tokenInfo?.isUser ?? false,
		);
	}

	private handleIncomingGatewayMessage(msg: DiscordMessage, db: Database): void {
		if (!msg.content && (!msg.attachments || msg.attachments.length === 0)) return;

		const channelId = msg.channel_id;
		const existingChannel = getChannel(`discord-${channelId}`, db);
		const channelName = existingChannel ? existingChannel.name : `#channel-${channelId}`;

		if (!existingChannel) {
			saveChannel(
				{
					id: `discord-${channelId}`,
					accountId: this.config.id,
					remoteId: channelId,
					name: channelName,
					kind: "channel",
					unreadCount: 0,
				},
				db,
			);
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

		const hubMsg = {
			accountId: this.config.id,
			remoteId: `${channelId}:${msg.id}`,
			channelId: `discord-${channelId}`,
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
				channelId,
				messageId: msg.id,
				authorId: msg.author.id,
				...(msg.referenced_message ? { replyToMessageId: msg.referenced_message.id } : {}),
			},
		};

		const { message: savedMsg, isNew } = saveIncomingMessage(hubMsg, undefined, db);
		if (isNew) {
			publishHubMessage(savedMsg);
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
		}
	}

	async sync(
		options: { force?: boolean; backfill?: boolean; backfillLimit?: number } = {},
		database?: Database,
	): Promise<{ syncedCount: number; unreadCount: number; error?: string }> {
		const db = database ?? getHubDb();
		const tokenInfo = this.getTokenInfo();
		const webhookUrl = this.getWebhookUrl();

		if (!tokenInfo && !webhookUrl) {
			const errorMsg =
				"Токен Discord не указан. Настройте Bot Token или User Token в панели управления.";
			updateAccountStatus(this.config.id, "disconnected", 0, errorMsg, db);
			publishHubAccountStatus({
				accountId: this.config.id,
				status: "disconnected",
				unreadCount: 0,
				error: errorMsg,
			});
			return { syncedCount: 0, unreadCount: 0, error: errorMsg };
		}

		const client = this.getClient();
		const guildId = this.getGuildId();
		const channelIds = this.getChannelIds();

		try {
			let currentUser: DiscordUser | undefined;
			if (tokenInfo) {
				try {
					currentUser = await client.getCurrentUser();
					const existingAccount = getAccount(this.config.id, db);
					if (existingAccount) {
						saveAccount(
							{
								...existingAccount,
								name: currentUser.global_name || currentUser.username || existingAccount.name,
								metadata: {
									...existingAccount.metadata,
									discordUserId: currentUser.id,
									username: currentUser.username,
									isBot: Boolean(currentUser.bot),
								},
							},
							db,
						);
					}

					// Start real-time Gateway WebSocket for bots
					if (!this.gatewayClient && !tokenInfo.isUser && !this.customClient) {
						this.gatewayClient = new DiscordGatewayClient(tokenInfo.token, (gatewayMsg) => {
							this.handleIncomingGatewayMessage(gatewayMsg, db);
						});
						this.gatewayClient.start();
					}
				} catch (authErr) {
					const errMsg = authErr instanceof Error ? authErr.message : String(authErr);
					log.error(`Discord auth failed for ${this.config.id}: ${errMsg}`);
					const existing = getAccount(this.config.id, db);
					const currentUnread = existing?.unreadCount ?? 0;
					updateAccountStatus(
						this.config.id,
						"error",
						currentUnread,
						`Ошибка авторизации Discord: ${errMsg}`,
						db,
					);
					publishHubAccountStatus({
						accountId: this.config.id,
						status: "error",
						unreadCount: currentUnread,
						error: `Ошибка авторизации Discord: ${errMsg}`,
					});
					return {
						syncedCount: 0,
						unreadCount: currentUnread,
						error: `Ошибка авторизации Discord: ${errMsg}`,
					};
				}
			}

			// 1. Identify channels
			let channels: DiscordChannel[] = [];
			if (channelIds && channelIds.length > 0) {
				channels = channelIds.map((cid) => ({
					id: cid,
					name: cid,
					type: 0,
				}));
			} else if (guildId) {
				try {
					const guildChannels = await client.getGuildChannels(guildId);
					channels = guildChannels.filter((c) => c.type === 0 || c.type === 5);
				} catch (err) {
					log.warn(`Could not get channels for specified guild ${guildId}: ${err}`);
					if (client.getUserGuilds) {
						try {
							const guilds = await client.getUserGuilds();
							for (const g of guilds) {
								const gChannels = await client.getGuildChannels(g.id);
								const textChans = gChannels.filter((c) => c.type === 0 || c.type === 5);
								channels.push(...textChans);
							}
						} catch {}
					}
					if (channels.length === 0) {
						throw err;
					}
				}
			} else {
				// Auto-discovery: text channels in all user/bot guilds
				if (client.getUserGuilds) {
					try {
						const guilds = await client.getUserGuilds();
						for (const g of guilds) {
							const gChannels = await client.getGuildChannels(g.id);
							const textChans = gChannels.filter((c) => c.type === 0 || c.type === 5);
							channels.push(...textChans);
						}
					} catch (e) {
						log.warn(`Could not auto-fetch guilds: ${e}`);
					}
				}
				if (client.getUserChannels && !currentUser?.bot) {
					try {
						const dms = await client.getUserChannels();
						channels.push(...dms);
					} catch (e) {
						log.warn(`Could not auto-fetch DMs: ${e}`);
					}
				}
			}

			const incomingMessages: Array<Omit<HubMessage, "id">> = [];

			for (const ch of channels) {
				const channelKind = ch.type === 1 || ch.type === 3 ? "dm" : "channel";
				let channelName = `#channel-${ch.id}`;
				if (ch.type === 1) {
					const recipient = ch.recipients?.[0]
						? ch.recipients[0].global_name || ch.recipients[0].username
						: ch.name || ch.id;
					channelName = `@${recipient}`;
				} else if (ch.type === 3) {
					channelName = ch.name ? `Group: ${ch.name}` : `Group-${ch.id}`;
				} else if (ch.name) {
					channelName = ch.name.startsWith("#") ? ch.name : `#${ch.name}`;
				}

				try {
					let fetchedMessages: DiscordMessage[] = [];
					if (options.backfill) {
						const maxBackfill = options.backfillLimit ?? 500;
						let oldestId: string | undefined;
						let fetchedCount = 0;
						while (fetchedCount < maxBackfill) {
							const queryOpts: DiscordGetMessagesOptions = {
								limit: Math.min(100, maxBackfill - fetchedCount),
							};
							if (oldestId) {
								queryOpts.before = oldestId;
							}
							const batch = await client.getChannelMessages(ch.id, queryOpts);
							if (batch.length === 0) break;
							fetchedMessages.push(...batch);
							fetchedCount += batch.length;
							const lastMsg = batch[batch.length - 1];
							if (!lastMsg) break;
							oldestId = lastMsg.id;
							if (batch.length < 100) break;
						}
					} else {
						const after = this.lastSyncMessageIds.get(ch.id);
						fetchedMessages = await client.getChannelMessages(
							ch.id,
							after ? { after, limit: 100 } : { limit: 100 },
						);
					}

					const hubChannel: HubChannel = {
						id: `discord-${ch.id}`,
						accountId: this.config.id,
						remoteId: ch.id,
						name: channelName,
						kind: channelKind,
						unreadCount: 0,
					};
					saveChannel(hubChannel, db);

					let maxId = this.lastSyncMessageIds.get(ch.id);
					for (const msg of fetchedMessages) {
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
				} catch (channelErr) {
					log.warn(`Skipping channel ${channelName} (${ch.id}): ${channelErr}`);
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
				error: `Ошибка синхронизации Discord: ${errorMsg}`,
			});
			return { syncedCount: 0, unreadCount: currentUnread, error: errorMsg };
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
			const webhookUrl = this.getWebhookUrl();
			const botToken = this.getBotToken();
			if (webhookUrl && !botToken && client.sendWebhookMessage) {
				const res = await client.sendWebhookMessage(webhookUrl, params.body);
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

	registerHubAccountSyncer(config.id, async (params) => {
		try {
			await connector.sync(
				params as { force?: boolean; backfill?: boolean; backfillLimit?: number },
			);
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
