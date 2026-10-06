import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	HubChannel,
	HubChannelKind,
	HubMessage,
	HubSendMessageParams,
	HubSendMessageResult,
} from "@thinkrail/contracts";
import QRCode from "qrcode";
import { TelegramClient } from "telegram";
import { NewMessage } from "telegram/events";
import { StringSession } from "telegram/sessions";
import { logger } from "../../log";
import type { TelegramAccountConfig } from "../accounts";
import {
	detectMessageUrgency,
	generateMessageSnippet,
	getAccount,
	getChannel,
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
	syncDialogs?(): Promise<number>;
	start?(): Promise<void>;
	stop?(): Promise<void>;
	isConnectedStatus?(): boolean;
	restart?(): Promise<void>;
	submitPassword?(password: string): boolean;
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

	submitPassword(_password: string): boolean {
		return true;
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
		if (!res.ok) {
			throw new Error(`Telegram getMe failed: ${res.statusText}`);
		}
		const json = (await res.json()) as {
			ok: boolean;
			result?: { id: number; username?: string; first_name: string };
			description?: string;
		};
		if (!json.ok || !json.result) {
			throw new Error(`Telegram getMe error: ${json.description ?? "Unknown error"}`);
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
		url.searchParams.set("timeout", "0"); // Non-blocking polling

		const res = await fetch(url.toString(), {
			headers: { Accept: "application/json" },
		});
		if (!res.ok) {
			throw new Error(`Telegram getUpdates failed: ${res.statusText}`);
		}
		const json = (await res.json()) as {
			ok: boolean;
			result?: TelegramUpdate[];
			description?: string;
		};
		if (!json.ok || !json.result) {
			throw new Error(`Telegram getUpdates error: ${json.description ?? "Unknown error"}`);
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
// GramJS MTProto User Client (QR Code Sign-in & Live Sync)
// ---------------------------------------------------------------------------

export class GramJsTelegramClient implements TelegramClientInterface {
	private accountId: string;
	private accountName: string;
	private authDir: string;
	private apiId: number;
	private apiHash: string;
	private client: TelegramClient | null = null;
	private isConnected = false;
	private isStarting = false;
	private latestQr?: string | undefined;
	private latestQrDataUrl?: string | undefined;
	private dialogsCache = new Map<string, string>();
	private pendingPasswordResolver: ((password: string) => void) | null = null;
	private enteredPassword: string | null = null;
	private currentPasswordHint = "";

	constructor(
		accountId: string,
		accountName: string,
		customAuthDir?: string,
		mtprotoConfig?: {
			apiId?: number;
			apiHash?: string;
			password?: string;
			twoFactorPassword?: string;
		},
	) {
		this.accountId = accountId;
		this.accountName = accountName;
		this.authDir = customAuthDir ?? join(homedir(), ".thinkrail", "telegram-auth");
		this.apiId =
			mtprotoConfig?.apiId ??
			(process.env.TELEGRAM_API_ID ? Number(process.env.TELEGRAM_API_ID) : 2040);
		this.apiHash =
			mtprotoConfig?.apiHash ?? process.env.TELEGRAM_API_HASH ?? "b18441a1ff607e10a989891a5462e627";
		this.enteredPassword =
			mtprotoConfig?.twoFactorPassword ??
			mtprotoConfig?.password ??
			process.env.TELEGRAM_2FA_PASSWORD ??
			process.env.TELEGRAM_PASSWORD ??
			null;
	}

	submitPassword(password: string): boolean {
		this.enteredPassword = password;
		if (this.pendingPasswordResolver) {
			const resolve = this.pendingPasswordResolver;
			this.pendingPasswordResolver = null;
			resolve(password);
			return true;
		}
		if (!this.isConnected && !this.isStarting) {
			void this.start();
		}
		return false;
	}

	private getSessionPath(): string {
		return join(this.authDir, "session.json");
	}

	private loadSavedSession(): string {
		const sessionPath = this.getSessionPath();
		if (existsSync(sessionPath)) {
			try {
				const raw = readFileSync(sessionPath, "utf8");
				const json = JSON.parse(raw) as { session?: string };
				return json.session || raw.trim();
			} catch {
				return "";
			}
		}
		return "";
	}

	private saveSession(sessionString: string): void {
		try {
			mkdirSync(this.authDir, { recursive: true });
			writeFileSync(this.getSessionPath(), JSON.stringify({ session: sessionString }, null, 2));
		} catch (err) {
			log.warn(`Failed to save Telegram session: ${err}`);
		}
	}

	private getUnreadCount(database?: Database): number {
		try {
			const db = database ?? getHubDb();
			const row = db
				.query("SELECT COUNT(*) as count FROM hub_messages WHERE account_id = ? AND is_read = 0;")
				.get(this.accountId) as { count: number } | null;
			return row?.count ?? 0;
		} catch {
			return 0;
		}
	}

	async start(): Promise<void> {
		if (this.isStarting || this.isConnected) return;
		this.isStarting = true;

		try {
			mkdirSync(this.authDir, { recursive: true });
			const savedSession = this.loadSavedSession();
			const stringSession = new StringSession(savedSession);

			const client = new TelegramClient(stringSession, this.apiId, this.apiHash, {
				connectionRetries: 5,
			});
			this.client = client;

			log.info(`Connecting to Telegram MTProto for ${this.accountId}...`);
			await client.connect();

			const isAuth = await client.checkAuthorization();
			if (isAuth) {
				log.info(`Telegram account ${this.accountId} already authorized.`);
				this.isConnected = true;
				this.isStarting = false;
				this.latestQr = undefined;
				this.latestQrDataUrl = undefined;

				const me = (await client.getMe().catch(() => null)) as Record<string, unknown> | null;
				const username = typeof me?.username === "string" ? me.username : undefined;
				const phone = typeof me?.phone === "string" ? me.phone : undefined;
				const fullName = [me?.firstName, me?.lastName]
					.filter((v): v is string => typeof v === "string" && v.length > 0)
					.join(" ");

				updateAccountStatus(this.accountId, "connected", this.getUnreadCount(), null, undefined, {
					connectedUser: fullName || username || "Telegram User",
					username,
					phone,
					id: me?.id ? String(me.id) : undefined,
				});
				publishHubAccountStatus({
					accountId: this.accountId,
					status: "connected",
					unreadCount: this.getUnreadCount(),
					metadata: {
						connectedUser: fullName || username || "Telegram User",
						username,
						phone,
					},
				});

				this.attachEventHandler(client);
				void this.syncDialogs();
				return;
			}

			// Not authorized -> Start QR code sign in flow
			log.info(`Starting Telegram QR sign-in flow for ${this.accountId}...`);
			updateAccountStatus(this.accountId, "connecting", this.getUnreadCount(), null, undefined, {
				qrCode: undefined,
			});
			publishHubAccountStatus({
				accountId: this.accountId,
				status: "connecting",
				unreadCount: this.getUnreadCount(),
			});

			void client
				.signInUserWithQrCode(
					{ apiId: this.apiId, apiHash: this.apiHash },
					{
						qrCode: async (code) => {
							const url = `tg://login?token=${code.token.toString("base64url")}`;
							try {
								const dataUrl = await QRCode.toDataURL(url, { margin: 2, scale: 6 });
								this.latestQr = url;
								this.latestQrDataUrl = dataUrl;
								const statusMetadata = {
									qrCode: url,
									qrCodeDataUrl: dataUrl,
									expires: code.expires,
									...(this.currentPasswordHint ? { passwordHint: this.currentPasswordHint } : {}),
									...(this.pendingPasswordResolver ? { needs2fa: true } : {}),
								};
								updateAccountStatus(
									this.accountId,
									"connecting",
									this.getUnreadCount(),
									this.pendingPasswordResolver ? "Требуется облачный пароль (2FA)" : null,
									undefined,
									statusMetadata,
								);
								publishHubAccountStatus({
									accountId: this.accountId,
									status: "connecting",
									unreadCount: this.getUnreadCount(),
									metadata: statusMetadata,
								});
							} catch (e) {
								log.warn(`Failed to generate Telegram QR code data URL: ${e}`);
							}
						},
						password: async (hint?: string) => {
							this.currentPasswordHint = hint || "";
							if (this.enteredPassword) {
								log.info(`Telegram 2FA: using pre-configured password for ${this.accountId}`);
								return this.enteredPassword;
							}

							log.info(
								`Telegram 2FA: waiting for cloud password for ${this.accountId} (hint: "${hint || ""}")`,
							);
							const metadata = {
								qrCode: this.latestQr,
								qrCodeDataUrl: this.latestQrDataUrl,
								needs2fa: true,
								passwordHint: hint || "",
							};
							updateAccountStatus(
								this.accountId,
								"connecting",
								this.getUnreadCount(),
								"Требуется облачный пароль (2FA)",
								undefined,
								metadata,
							);
							publishHubAccountStatus({
								accountId: this.accountId,
								status: "connecting",
								unreadCount: this.getUnreadCount(),
								metadata,
							});

							return new Promise<string>((resolve, reject) => {
								let timer: ReturnType<typeof setTimeout> | null = null;
								this.pendingPasswordResolver = (pass: string) => {
									if (timer) clearTimeout(timer);
									resolve(pass);
								};
								timer = setTimeout(() => {
									if (this.pendingPasswordResolver) {
										this.pendingPasswordResolver = null;
										reject(new Error("Timeout waiting for 2FA password"));
									}
								}, 300_000);
							});
						},
						onError: (err) => {
							log.warn(`Telegram QR auth error callback: ${err}`);
							const msg = err.message || String(err);
							if (msg.includes("PASSWORD_HASH_INVALID") || msg.includes("PASSWORD_EMPTY")) {
								this.enteredPassword = null;
								const meta = {
									qrCode: this.latestQr,
									qrCodeDataUrl: this.latestQrDataUrl,
									needs2fa: true,
									passwordHint: this.currentPasswordHint,
									error: "Неверный облачный пароль 2FA. Попробуйте еще раз.",
								};
								updateAccountStatus(
									this.accountId,
									"connecting",
									this.getUnreadCount(),
									"Неверный пароль 2FA",
									undefined,
									meta,
								);
								publishHubAccountStatus({
									accountId: this.accountId,
									status: "connecting",
									unreadCount: this.getUnreadCount(),
									metadata: meta,
								});
							}
						},
					},
				)
				.then(async () => {
					log.info(`Telegram QR sign in completed successfully for ${this.accountId}!`);
					this.isConnected = true;
					this.isStarting = false;
					this.latestQr = undefined;
					this.latestQrDataUrl = undefined;

					const sessionStr = client.session.save() as unknown as string;
					this.saveSession(sessionStr);

					const me = (await client.getMe().catch(() => null)) as Record<string, unknown> | null;
					const username = typeof me?.username === "string" ? me.username : undefined;
					const phone = typeof me?.phone === "string" ? me.phone : undefined;
					const fullName = [me?.firstName, me?.lastName]
						.filter((v): v is string => typeof v === "string" && v.length > 0)
						.join(" ");

					updateAccountStatus(this.accountId, "connected", this.getUnreadCount(), null, undefined, {
						connectedUser: fullName || username || "Telegram User",
						username,
						phone,
					});
					publishHubAccountStatus({
						accountId: this.accountId,
						status: "connected",
						unreadCount: this.getUnreadCount(),
						metadata: {
							connectedUser: fullName || username || "Telegram User",
							username,
							phone,
						},
					});

					this.attachEventHandler(client);
					void this.syncDialogs();
				})
				.catch((err) => {
					this.isStarting = false;
					log.warn(`Telegram QR auth ended with: ${err}`);
				});
		} catch (err) {
			this.isStarting = false;
			this.isConnected = false;
			const errorMsg = err instanceof Error ? err.message : String(err);
			log.error(`Failed to start GramJsTelegramClient: ${errorMsg}`);
			updateAccountStatus(this.accountId, "error", this.getUnreadCount(), errorMsg);
			publishHubAccountStatus({
				accountId: this.accountId,
				status: "error",
				unreadCount: this.getUnreadCount(),
				error: errorMsg,
			});
		}
	}

	private attachEventHandler(client: TelegramClient): void {
		client.addEventHandler(async (event: unknown) => {
			try {
				const ev = event as { message?: Record<string, unknown> } | undefined;
				const rawMsg = ev?.message as unknown as {
					id: number;
					message?: string;
					text?: string;
					chatId?: { toString(): string };
					date: number;
					out?: boolean;
					isPrivate?: boolean;
					isChannel?: boolean;
					media?: unknown;
					replyTo?: { replyToMsgId?: number };
					getChat(): Promise<Record<string, unknown>>;
					getSender(): Promise<Record<string, unknown>>;
				};
				if (!rawMsg) return;

				const text = rawMsg.message || rawMsg.text || "";
				const chatId = rawMsg.chatId?.toString() || "";
				if (!chatId) return;

				let chatTitle = this.dialogsCache.get(chatId);
				if (!chatTitle) {
					try {
						const chat = await rawMsg.getChat();
						const parts = [chat.firstName, chat.lastName]
							.filter((v): v is string => typeof v === "string" && v.length > 0)
							.join(" ");
						chatTitle =
							(typeof chat.title === "string" ? chat.title : "") ||
							parts ||
							(typeof chat.username === "string" ? `@${chat.username}` : `Chat ${chatId}`);
						if (chatTitle) this.dialogsCache.set(chatId, chatTitle);
					} catch {
						chatTitle = `Chat ${chatId}`;
					}
				}

				const sender = await rawMsg.getSender().catch(() => null);
				const senderParts = sender
					? [sender.firstName, sender.lastName]
							.filter((v): v is string => typeof v === "string" && v.length > 0)
							.join(" ")
					: "";
				const senderName = sender
					? senderParts ||
						(typeof sender.title === "string" ? sender.title : "") ||
						(typeof sender.username === "string" ? sender.username : `User ${sender.id}`)
					: chatTitle;
				const senderAddress = sender?.username
					? `@${sender.username}`
					: sender?.id
						? String(sender.id)
						: chatId;

				const db = getHubDb();
				const channelId = `tg-${chatId}`;
				const existingChannel = getChannel(channelId, db);
				const channelKind: HubChannelKind = rawMsg.isPrivate
					? "dm"
					: rawMsg.isChannel
						? "channel"
						: "group";

				saveChannel(
					{
						id: channelId,
						accountId: this.accountId,
						remoteId: chatId,
						name: chatTitle,
						kind: channelKind,
						unreadCount: (existingChannel?.unreadCount ?? 0) + (rawMsg.out ? 0 : 1),
						lastMessageAt: rawMsg.date * 1000,
					},
					db,
				);

				const snippet = generateMessageSnippet(text);
				const isUrgent = detectMessageUrgency(undefined, text);

				const message: HubMessage = {
					id: randomUUID(),
					accountId: this.accountId,
					remoteId: String(rawMsg.id),
					channelId,
					senderName,
					senderAddress,
					recipientAddress: chatId,
					body: text,
					snippet,
					timestamp: rawMsg.date * 1000,
					isRead: Boolean(rawMsg.out),
					isUrgent,
					hasAttachments: Boolean(rawMsg.media),
					metadata: {
						chatId,
						chatTitle,
						out: rawMsg.out,
						replyToMessageId: rawMsg.replyTo?.replyToMsgId
							? String(rawMsg.replyTo.replyToMsgId)
							: undefined,
					},
				};

				saveIncomingMessages([message], undefined, db);
				publishHubMessage(message);

				const totalUnread = this.getUnreadCount(db);
				updateAccountStatus(this.accountId, "connected", totalUnread, null, db);
				publishHubAccountStatus({
					accountId: this.accountId,
					status: "connected",
					unreadCount: totalUnread,
				});
			} catch (err) {
				log.warn(`Error processing incoming Telegram message: ${err}`);
			}
		}, new NewMessage({}));
	}

	async syncDialogs(): Promise<number> {
		if (!this.client || !this.isConnected) return 0;
		try {
			log.info(`Syncing Telegram dialogs for ${this.accountId}...`);
			const dialogs = await this.client.getDialogs({ limit: 50 });
			const db = getHubDb();
			let count = 0;
			const incomingMessages: Array<Omit<HubMessage, "id">> = [];

			for (const dialog of dialogs) {
				const chatId = dialog.id?.toString();
				if (!chatId) continue;

				const title = dialog.title || dialog.name || `Chat ${chatId}`;
				this.dialogsCache.set(chatId, title);

				const channelId = `tg-${chatId}`;
				const existing = getChannel(channelId, db);
				const channelKind: HubChannelKind = dialog.isUser
					? "dm"
					: dialog.isChannel
						? "channel"
						: "group";

				saveChannel(
					{
						id: channelId,
						accountId: this.accountId,
						remoteId: chatId,
						name: title,
						kind: channelKind,
						unreadCount: dialog.unreadCount ?? (existing?.unreadCount || 0),
						lastMessageAt: dialog.message?.date ? dialog.message.date * 1000 : Date.now(),
					},
					db,
				);
				count++;

				if (dialog.message) {
					const msg = dialog.message as unknown as {
						id: number;
						message?: string;
						text?: string;
						out?: boolean;
						date: number;
						media?: unknown;
					};
					const text = msg.message || msg.text || "";
					if (text) {
						const senderName = msg.out ? this.accountName : title;
						const senderAddress = msg.out ? `tg:${this.accountId}` : chatId;
						const snippet = generateMessageSnippet(text);
						const isUrgent = detectMessageUrgency(undefined, text);

						incomingMessages.push({
							accountId: this.accountId,
							remoteId: String(msg.id),
							channelId,
							senderName,
							senderAddress,
							recipientAddress: chatId,
							body: text,
							snippet,
							timestamp: msg.date * 1000,
							isRead: Boolean(msg.out) || (dialog.unreadCount ?? 0) === 0,
							isUrgent,
							hasAttachments: Boolean(msg.media),
							metadata: {
								chatId,
								chatTitle: title,
							},
						});
					}
				}
			}

			if (incomingMessages.length > 0) {
				saveIncomingMessages(incomingMessages, undefined, db);
			}

			const totalUnread = this.getUnreadCount(db);
			updateAccountStatus(this.accountId, "connected", totalUnread, null, db);
			publishHubAccountStatus({
				accountId: this.accountId,
				status: "connected",
				unreadCount: totalUnread,
			});

			log.info(`Synced ${count} Telegram dialogs for ${this.accountId}.`);
			return count;
		} catch (err) {
			log.warn(`Failed to sync Telegram dialogs: ${err}`);
			return 0;
		}
	}

	async sendMessage(
		chatId: string | number,
		text: string,
		replyToMessageId?: string | number,
	): Promise<{ messageId: string | number }> {
		if (!this.client) {
			throw new Error("Telegram client is not connected");
		}
		const sendParams: Record<string, unknown> = {
			message: text,
		};
		if (replyToMessageId !== undefined) {
			sendParams.replyTo = Number(replyToMessageId);
		}
		const res = (await this.client.sendMessage(chatId, sendParams)) as { id?: number };
		return { messageId: res?.id ?? randomUUID() };
	}

	async stop(): Promise<void> {
		this.pendingPasswordResolver = null;
		if (this.client) {
			try {
				await this.client.disconnect();
			} catch {}
			this.client = null;
		}
		this.isConnected = false;
		this.isStarting = false;
		this.latestQr = undefined;
		this.latestQrDataUrl = undefined;
	}

	async restart(): Promise<void> {
		await this.stop();
		await this.start();
	}

	isConnectedStatus(): boolean {
		return this.isConnected;
	}

	async getMe(): Promise<{ id: number; username?: string; firstName: string }> {
		if (!this.client) return { id: 0, firstName: this.accountName };
		const me = (await this.client.getMe().catch(() => null)) as Record<string, unknown> | null;
		return {
			id: Number(me?.id ?? 0),
			...(typeof me?.username === "string" ? { username: me.username } : {}),
			firstName: typeof me?.firstName === "string" ? me.firstName : this.accountName,
		};
	}

	async fetchUpdates(
		_offset = 0,
		_limit = 100,
	): Promise<{ updates: TelegramUpdate[]; nextOffset: number }> {
		await this.syncDialogs();
		return { updates: [], nextOffset: _offset };
	}
}

// ---------------------------------------------------------------------------
// Telegram Connector Core Service
// ---------------------------------------------------------------------------

export const activeTelegramConnectors = new Map<string, TelegramConnector>();

export function submitTelegramPassword(accountId: string, password: string): boolean {
	const conn = activeTelegramConnectors.get(accountId);
	if (conn) {
		return conn.submitPassword(password);
	}
	return false;
}

export class TelegramConnector {
	private config: TelegramAccountConfig;
	private customClient?: TelegramClientInterface;
	private gramJsClient?: GramJsTelegramClient;
	private lastUpdateOffset = 0;

	constructor(config: TelegramAccountConfig, client?: TelegramClientInterface) {
		this.config = config;
		if (client) {
			this.customClient = client;
		} else if (!config.bot?.botToken && !(config as { botToken?: string }).botToken) {
			const password =
				config.password ??
				config.twoFactorPassword ??
				config.mtproto?.password ??
				config.mtproto?.twoFactorPassword;
			this.gramJsClient = new GramJsTelegramClient(config.id, config.name, config.authDir, {
				...(config.mtproto || {}),
				...(password ? { password } : {}),
			});
		}
		activeTelegramConnectors.set(this.config.id, this);
	}

	submitPassword(password: string): boolean {
		if (this.customClient?.submitPassword) {
			return this.customClient.submitPassword(password);
		}
		if (this.gramJsClient) {
			return this.gramJsClient.submitPassword(password);
		}
		return false;
	}

	private getClient(): TelegramClientInterface {
		if (this.customClient) return this.customClient;
		if (this.gramJsClient) return this.gramJsClient;
		const token = this.config.bot?.botToken ?? (this.config as { botToken?: string }).botToken;
		if (token) {
			return new HttpTelegramBotClient(token, this.config.bot?.apiBaseUrl);
		}
		const password =
			this.config.password ??
			this.config.twoFactorPassword ??
			this.config.mtproto?.password ??
			this.config.mtproto?.twoFactorPassword;
		this.gramJsClient = new GramJsTelegramClient(
			this.config.id,
			this.config.name,
			this.config.authDir,
			{
				...(this.config.mtproto || {}),
				...(password ? { password } : {}),
			},
		);
		return this.gramJsClient;
	}

	async start(): Promise<void> {
		if (this.customClient?.start) {
			await this.customClient.start();
			return;
		}
		if (this.gramJsClient) {
			await this.gramJsClient.start();
		}
	}

	async stop(): Promise<void> {
		activeTelegramConnectors.delete(this.config.id);
		if (this.customClient?.stop) {
			await this.customClient.stop();
			return;
		}
		if (this.gramJsClient) {
			await this.gramJsClient.stop();
		}
	}

	async restart(): Promise<void> {
		if (this.customClient?.restart) {
			await this.customClient.restart();
			return;
		}
		if (this.gramJsClient) {
			await this.gramJsClient.restart();
		}
	}

	isConnectedStatus(): boolean {
		if (this.customClient?.isConnectedStatus) {
			return this.customClient.isConnectedStatus();
		}
		if (this.gramJsClient) {
			return this.gramJsClient.isConnectedStatus();
		}
		return true;
	}

	async sync(
		_options: { force?: boolean } = {},
		database?: Database,
	): Promise<{ syncedCount: number; unreadCount: number }> {
		const db = database ?? getHubDb();
		const client = this.getClient();

		try {
			if (client.syncDialogs) {
				const syncedCount = await client.syncDialogs();
				const unreadRow = db
					.query("SELECT COUNT(*) as count FROM hub_messages WHERE account_id = ? AND is_read = 0;")
					.get(this.config.id) as { count: number } | null;
				const totalUnread = unreadRow?.count ?? 0;
				return { syncedCount, unreadCount: totalUnread };
			}

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
			if (_params?.force && !connector.isConnectedStatus()) {
				await connector.restart();
			} else {
				await connector.sync(_params);
			}
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

	if (!client && !config.bot?.botToken && !(config as { botToken?: string }).botToken) {
		void connector.start();
	}

	return connector;
}
