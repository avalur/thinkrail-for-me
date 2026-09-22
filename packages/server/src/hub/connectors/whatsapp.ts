import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	HubChannel,
	HubMessage,
	HubSendMessageParams,
	HubSendMessageResult,
} from "@thinkrail/contracts";
import makeWASocket, { DisconnectReason, useMultiFileAuthState } from "@whiskeysockets/baileys";
import pino from "pino";
import QRCode from "qrcode";
import { logger } from "../../log";
import type { WhatsAppAccountConfig } from "../accounts";
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

const log = logger("hub:whatsapp");

// ---------------------------------------------------------------------------
// WhatsApp Domain Types
// ---------------------------------------------------------------------------

export interface WhatsAppMessage {
	id: string;
	from: string; // Phone number or JID, e.g. "+15551234567" or "15551234567@s.whatsapp.net"
	to?: string;
	text: string;
	timestamp: number; // Milliseconds timestamp
	senderName?: string;
	isGroup?: boolean;
	groupId?: string;
	groupName?: string;
	replyToMessageId?: string;
}

// ---------------------------------------------------------------------------
// WhatsApp Client Interface & Implementations
// ---------------------------------------------------------------------------

export interface WhatsAppClientInterface {
	getAccountInfo(): Promise<{ id: string; name?: string; phone?: string }>;
	fetchMessages(since?: number, limit?: number): Promise<WhatsAppMessage[]>;
	sendMessage(to: string, text: string, replyToMessageId?: string): Promise<{ messageId: string }>;
	syncGroups?(): Promise<number>;
	start?(): Promise<void>;
	stop?(): Promise<void>;
	isConnectedStatus?(): boolean;
	restart?(): Promise<void>;
	ensureActive?(): Promise<void>;
}

export class MockWhatsAppClient implements WhatsAppClientInterface {
	public messagesQueue: WhatsAppMessage[] = [];
	public sentMessages: Array<{
		to: string;
		text: string;
		replyToMessageId?: string;
		messageId: string;
	}> = [];
	public accountInfo = {
		id: "wa_account_mock",
		name: "My WhatsApp Account",
		phone: "+15550001111",
	};
	private currentMsgCounter = 7000;

	constructor(initialMessages: WhatsAppMessage[] = []) {
		this.messagesQueue = [...initialMessages];
	}

	async getAccountInfo(): Promise<{ id: string; name?: string; phone?: string }> {
		return { ...this.accountInfo };
	}

	async fetchMessages(since = 0, limit = 50): Promise<WhatsAppMessage[]> {
		return this.messagesQueue.filter((m) => m.timestamp > since).slice(0, limit);
	}

	async sendMessage(
		to: string,
		text: string,
		replyToMessageId?: string,
	): Promise<{ messageId: string }> {
		this.currentMsgCounter += 1;
		const messageId = `wamid.${randomUUID().slice(0, 12)}_${this.currentMsgCounter}`;
		this.sentMessages.push({
			to,
			text,
			...(replyToMessageId ? { replyToMessageId } : {}),
			messageId,
		});
		return { messageId };
	}
}

export class HttpWhatsAppCloudClient implements WhatsAppClientInterface {
	private phoneNumberId?: string | undefined;
	private accessToken?: string | undefined;
	private apiBaseUrl: string;
	private bufferedIncoming: WhatsAppMessage[] = [];

	constructor(
		phoneNumberId?: string,
		accessToken?: string,
		apiBaseUrl = "https://graph.facebook.com/v20.0",
	) {
		this.phoneNumberId = phoneNumberId;
		this.accessToken = accessToken;
		this.apiBaseUrl = apiBaseUrl.replace(/\/+$/, "");
	}

	pushBufferedMessage(msg: WhatsAppMessage): void {
		this.bufferedIncoming.push(msg);
	}

	async getAccountInfo(): Promise<{ id: string; name?: string; phone?: string }> {
		if (!this.phoneNumberId || !this.accessToken) {
			return { id: "unknown", name: "WhatsApp Business" };
		}

		const res = await fetch(`${this.apiBaseUrl}/${this.phoneNumberId}`, {
			headers: {
				Authorization: `Bearer ${this.accessToken}`,
				Accept: "application/json",
			},
		});

		if (!res.ok) {
			return { id: this.phoneNumberId, name: "WhatsApp Business" };
		}

		const json = (await res.json()) as {
			id: string;
			verified_name?: string;
			display_phone_number?: string;
		};
		return {
			id: json.id,
			...(json.verified_name ? { name: json.verified_name } : {}),
			...(json.display_phone_number ? { phone: json.display_phone_number } : {}),
		};
	}

	async fetchMessages(since = 0, limit = 50): Promise<WhatsAppMessage[]> {
		const filtered = this.bufferedIncoming.filter((m) => m.timestamp > since).slice(0, limit);
		return filtered;
	}

	async sendMessage(
		to: string,
		text: string,
		replyToMessageId?: string,
	): Promise<{ messageId: string }> {
		if (!this.phoneNumberId || !this.accessToken) {
			throw new Error("WhatsApp Cloud API requires phoneNumberId and accessToken");
		}

		// Normalize target phone number (digits only, e.g. "15551234567")
		const cleanTo = to.replace(/[^0-9]/g, "");

		const payload: Record<string, unknown> = {
			messaging_product: "whatsapp",
			recipient_type: "individual",
			to: cleanTo,
			type: "text",
			text: { body: text },
		};

		if (replyToMessageId) {
			payload.context = { message_id: replyToMessageId };
		}

		const res = await fetch(`${this.apiBaseUrl}/${this.phoneNumberId}/messages`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.accessToken}`,
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify(payload),
		});

		if (!res.ok) {
			let errorMsg = res.statusText;
			try {
				const errJson = (await res.json()) as { error?: { message?: string } };
				if (errJson.error?.message) errorMsg = errJson.error.message;
			} catch {
				// use statusText
			}
			throw new Error(`WhatsApp API error: ${errorMsg}`);
		}

		const json = (await res.json()) as { messages?: Array<{ id: string }> };
		const messageId = json.messages?.[0]?.id ?? `wa_${randomUUID()}`;
		return { messageId };
	}
}

export class BaileysWhatsAppClient implements WhatsAppClientInterface {
	private accountId: string;
	private accountName: string;
	private authDir: string;
	private sock: ReturnType<typeof makeWASocket> | null = null;
	private isConnected = false;
	private isStarting = false;
	private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
	private latestQr?: string | undefined;
	private latestQrDataUrl?: string | undefined;
	private groupNameCache = new Map<string, string>();
	private contactNameCache = new Map<string, string>();

	constructor(accountId: string, accountName: string, customAuthDir?: string) {
		this.accountId = accountId;
		this.accountName = accountName;
		this.authDir = customAuthDir ?? join(homedir(), ".thinkrail", "whatsapp-auth");
	}

	async syncGroups(): Promise<number> {
		if (!this.sock) return 0;
		try {
			log.info(`Syncing WhatsApp participating groups for ${this.accountId}...`);
			const groups = await (this.sock as any).groupFetchAllParticipating();
			const db = getHubDb();
			let count = 0;
			for (const [groupJid, group] of Object.entries(groups as Record<string, any>)) {
				if (!groupJid || !group?.subject) continue;
				this.groupNameCache.set(groupJid, group.subject);
				const channelId = `wa-${groupJid}`;
				const existing = getChannel(channelId, db);
				const channel: HubChannel = {
					id: channelId,
					accountId: this.accountId,
					remoteId: groupJid,
					name: group.subject,
					kind: "group",
					unreadCount: existing?.unreadCount ?? 0,
					lastMessageAt:
						existing?.lastMessageAt ?? (group.creation ? group.creation * 1000 : Date.now()),
					metadata: {
						owner: group.owner,
						participantsCount: group.participants?.length,
						desc: group.desc,
					},
				};
				saveChannel(channel, db);
				count++;

				db.run(
					`UPDATE hub_messages 
					 SET subject = ?,
					     channel_id = ?
					 WHERE account_id = ? AND (channel_id = ? OR sender_address = ? OR recipient_address = ?);`,
					[group.subject, channelId, this.accountId, channelId, groupJid, groupJid],
				);
			}
			log.info(`Synced ${count} WhatsApp groups with subjects.`);
			return count;
		} catch (err) {
			log.warn(`Failed to sync WhatsApp groups: ${err}`);
			return 0;
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
		if (this.sock || this.isStarting) return;
		this.isStarting = true;

		try {
			if (!existsSync(this.authDir)) {
				mkdirSync(this.authDir, { recursive: true, mode: 0o700 });
			}

			const { state, saveCreds } = await useMultiFileAuthState(this.authDir);

			const sock = makeWASocket({
				auth: state,
				logger: pino({ level: "silent" }) as any,
				printQRInTerminal: false,
				browser: ["ThinkRail Personal Hub", "Desktop", "1.0.0"],
				syncFullHistory: false,
			});
			this.sock = sock;

			sock.ev.on("creds.update", saveCreds);

			sock.ev.on("connection.update", async (update) => {
				const { connection, lastDisconnect, qr } = update;

				if (qr) {
					this.latestQr = qr;
					try {
						const dataUrl = await QRCode.toDataURL(qr, { margin: 2, scale: 6 });
						this.latestQrDataUrl = dataUrl;
						log.info(`WhatsApp QR code generated for linking device (${this.accountId}).`);
						updateAccountStatus(
							this.accountId,
							"connecting",
							this.getUnreadCount(),
							null,
							undefined,
							{ qrCode: qr, qrCodeDataUrl: dataUrl },
						);
						publishHubAccountStatus({
							accountId: this.accountId,
							status: "connecting",
							unreadCount: this.getUnreadCount(),
							metadata: { qrCode: qr, qrCodeDataUrl: dataUrl },
						});
					} catch (err) {
						log.error(`Failed to generate WhatsApp QR data URL: ${err}`);
					}
				}

				if (connection === "open") {
					this.isConnected = true;
					this.latestQr = undefined;
					this.latestQrDataUrl = undefined;
					const user = sock.user;
					const phone = user?.id ? user.id.split(":")[0] : undefined;
					log.info(`WhatsApp connected as Linked Device (phone: ${phone})!`);
					updateAccountStatus(this.accountId, "connected", this.getUnreadCount(), null, undefined, {
						connectedPhone: phone,
						jid: user?.id,
					});
					publishHubAccountStatus({
						accountId: this.accountId,
						status: "connected",
						unreadCount: this.getUnreadCount(),
						metadata: { connectedPhone: phone, jid: user?.id },
					});
					void this.syncGroups();
				} else if (connection === "close") {
					this.isConnected = false;
					const statusCode = (
						lastDisconnect?.error as unknown as { output?: { statusCode?: number } }
					)?.output?.statusCode;
					const isLoggedOut = statusCode === DisconnectReason.loggedOut;
					log.warn(`WhatsApp connection closed. Status: ${statusCode}, loggedOut: ${isLoggedOut}`);

					if (this.sock) {
						try {
							this.sock.ev.removeAllListeners("connection.update");
							this.sock.ev.removeAllListeners("creds.update");
							this.sock.ev.removeAllListeners("messages.upsert");
							this.sock.ev.removeAllListeners("messaging-history.set");
							this.sock.ev.removeAllListeners("groups.update");
							this.sock.ev.removeAllListeners("chats.upsert");
							this.sock.ev.removeAllListeners("chats.update");
							this.sock.ev.removeAllListeners("contacts.upsert");
							this.sock.ev.removeAllListeners("contacts.update");
							this.sock.end(undefined);
						} catch {}
						this.sock = null;
					}

					if (isLoggedOut) {
						try {
							rmSync(this.authDir, { recursive: true, force: true });
						} catch {}
						this.latestQr = undefined;
						this.latestQrDataUrl = undefined;
						updateAccountStatus(
							this.accountId,
							"disconnected",
							0,
							"Logged out from WhatsApp on phone",
						);
						publishHubAccountStatus({
							accountId: this.accountId,
							status: "disconnected",
							unreadCount: 0,
							error: "Logged out",
						});
					} else {
						if (!this.reconnectTimeout) {
							this.reconnectTimeout = setTimeout(() => {
								this.reconnectTimeout = null;
								void this.start();
							}, 2000);
						}
					}
				}
			});

			sock.ev.on("groups.update", async (updates: any[]) => {
				const db = getHubDb();
				for (const update of updates) {
					if (update.id && update.subject) {
						this.groupNameCache.set(update.id, update.subject);
						const channelId = `wa-${update.id}`;
						const existing = getChannel(channelId, db);
						if (existing) {
							existing.name = update.subject;
							saveChannel(existing, db);
						}
						db.run("UPDATE hub_messages SET subject = ? WHERE account_id = ? AND channel_id = ?;", [
							update.subject,
							this.accountId,
							channelId,
						]);
					}
				}
			});

			sock.ev.on("chats.upsert", (chats: any[]) => {
				for (const ch of chats) {
					const name = ch.name || ch.subject;
					if (ch.id && name) {
						this.groupNameCache.set(ch.id, name);
						const db = getHubDb();
						const channelId = `wa-${ch.id}`;
						const existing = getChannel(channelId, db);
						saveChannel(
							{
								id: channelId,
								accountId: this.accountId,
								remoteId: ch.id,
								name,
								kind: ch.id.endsWith("@g.us") ? "group" : "dm",
								unreadCount: existing?.unreadCount ?? (ch.unreadCount || 0),
								lastMessageAt: existing?.lastMessageAt ?? Date.now(),
							},
							db,
						);
					}
				}
			});

			sock.ev.on("chats.update", (chats: any[]) => {
				for (const ch of chats) {
					const name = ch.name || ch.subject;
					if (ch.id && name) {
						this.groupNameCache.set(ch.id, name);
						const db = getHubDb();
						const channelId = `wa-${ch.id}`;
						const existing = getChannel(channelId, db);
						if (existing) {
							existing.name = name;
							saveChannel(existing, db);
						}
					}
				}
			});

			sock.ev.on("contacts.upsert", (contacts: any[]) => {
				for (const c of contacts) {
					const name = c.name || c.notify || c.verifiedName;
					if (c.id && name) {
						this.contactNameCache.set(c.id, name);
					}
				}
			});

			sock.ev.on("contacts.update", (contacts: any[]) => {
				for (const c of contacts) {
					const name = c.name || c.notify || c.verifiedName;
					if (c.id && name) {
						this.contactNameCache.set(c.id, name);
					}
				}
			});

			sock.ev.on("messages.upsert", async ({ messages }: { messages: any[] }) => {
				this.processRawMessages(messages);
			});

			sock.ev.on(
				"messaging-history.set",
				async (history: { messages?: any[]; chats?: any[]; contacts?: any[] }) => {
					if (history.contacts) {
						for (const c of history.contacts) {
							const name = c.name || c.notify || c.verifiedName;
							if (c.id && name) {
								this.contactNameCache.set(c.id, name);
							}
						}
					}
					if (history.chats) {
						for (const ch of history.chats) {
							const name = ch.name || ch.subject;
							if (ch.id && name) {
								this.groupNameCache.set(ch.id, name);
								const db = getHubDb();
								const channelId = `wa-${ch.id}`;
								const existing = getChannel(channelId, db);
								saveChannel(
									{
										id: channelId,
										accountId: this.accountId,
										remoteId: ch.id,
										name,
										kind: ch.id.endsWith("@g.us") ? "group" : "dm",
										unreadCount: existing?.unreadCount ?? (ch.unreadCount || 0),
										lastMessageAt: existing?.lastMessageAt ?? Date.now(),
									},
									db,
								);
							}
						}
					}
					if (history.messages && history.messages.length > 0) {
						this.processRawMessages(history.messages);
					}
					void this.syncGroups();
				},
			);
		} catch (err) {
			log.error(`Failed to start Baileys WhatsApp client: ${err}`);
			updateAccountStatus(this.accountId, "error", 0, String(err));
			publishHubAccountStatus({
				accountId: this.accountId,
				status: "error",
				unreadCount: 0,
				error: String(err),
			});
		} finally {
			this.isStarting = false;
		}
	}

	private processRawMessages(messages: any[]): void {
		for (const m of messages) {
			const jid = m.key?.remoteJid;
			if (!jid || jid === "status@broadcast") continue;

			const text =
				m.message?.conversation ||
				m.message?.extendedTextMessage?.text ||
				m.message?.imageMessage?.caption ||
				m.message?.videoMessage?.caption ||
				m.message?.documentMessage?.caption ||
				"";

			if (!text) continue;

			const isFromMe = Boolean(m.key?.fromMe);
			const isGroup = jid.endsWith("@g.us");
			const participantJid = m.key?.participant || m.participant;

			if (participantJid && m.pushName) {
				this.contactNameCache.set(participantJid, m.pushName);
			}
			if (!isGroup && jid && m.pushName) {
				this.contactNameCache.set(jid, m.pushName);
			}

			let senderName = "Contact";
			if (isFromMe) {
				senderName = "Me";
			} else if (m.pushName) {
				senderName = m.pushName;
			} else if (isGroup && participantJid) {
				senderName =
					this.contactNameCache.get(participantJid) ||
					participantJid.split("@")[0] ||
					"Participant";
			} else {
				senderName = this.contactNameCache.get(jid) || jid.split("@")[0] || "Contact";
			}

			const timestamp =
				typeof m.messageTimestamp === "number"
					? m.messageTimestamp * 1000
					: typeof m.messageTimestamp === "bigint"
						? Number(m.messageTimestamp) * 1000
						: Date.now();

			const channelRemoteId = jid;
			const channelKind = isGroup ? "group" : "dm";
			const groupName = isGroup ? this.groupNameCache.get(jid) : undefined;
			const channelName = isGroup ? groupName || jid : senderName;

			const channel: HubChannel = {
				id: `wa-${channelRemoteId}`,
				accountId: this.accountId,
				remoteId: channelRemoteId,
				name: channelName,
				kind: channelKind,
				unreadCount: 0,
				lastMessageAt: timestamp,
			};
			saveChannel(channel);

			const snippet = generateMessageSnippet(text);
			const isUrgent = detectMessageUrgency(undefined, text);

			const hubMsg: HubMessage = {
				id: randomUUID(),
				accountId: this.accountId,
				remoteId: m.key?.id || `wa_${randomUUID()}`,
				channelId: channel.id,
				senderName,
				senderAddress: isGroup ? participantJid || jid : jid,
				recipientAddress: isFromMe ? jid : isGroup ? jid : "Me",
				...(isGroup && groupName ? { subject: groupName } : {}),
				body: text,
				snippet,
				timestamp,
				isRead: isFromMe,
				isUrgent,
				hasAttachments: Boolean(m.message?.imageMessage || m.message?.documentMessage),
				metadata: {
					jid,
					fromMe: isFromMe,
					pushName: m.pushName,
					isGroup,
					groupId: isGroup ? jid : undefined,
					groupName: isGroup ? groupName : undefined,
					participant: participantJid,
					...(m.message?.extendedTextMessage?.contextInfo?.stanzaId
						? { replyToMessageId: m.message.extendedTextMessage.contextInfo.stanzaId }
						: {}),
				},
			};

			const { inserted } = saveIncomingMessages([hubMsg]);
			for (const item of inserted) {
				publishHubMessage(item);
			}

			const totalUnread = this.getUnreadCount();
			updateAccountStatus(this.accountId, "connected", totalUnread);
			publishHubAccountStatus({
				accountId: this.accountId,
				status: "connected",
				unreadCount: totalUnread,
			});
		}
	}

	isConnectedStatus(): boolean {
		return this.isConnected;
	}

	async ensureActive(): Promise<void> {
		if (!this.isConnected && !this.sock && !this.isStarting) {
			await this.start();
		}
	}

	async restart(): Promise<void> {
		await this.stop();
		await this.start();
	}

	async stop(): Promise<void> {
		if (this.reconnectTimeout) {
			clearTimeout(this.reconnectTimeout);
			this.reconnectTimeout = null;
		}
		if (this.sock) {
			try {
				this.sock.end(undefined);
			} catch {}
			this.sock = null;
		}
		this.isConnected = false;
	}

	async getAccountInfo(): Promise<{ id: string; name?: string; phone?: string }> {
		const user = this.sock?.user;
		const phone = user?.id ? user.id.split(":")[0] : undefined;
		return {
			id: user?.id ?? this.accountId,
			name: this.accountName,
			...(phone ? { phone } : {}),
		};
	}

	async fetchMessages(since = 0, limit = 50): Promise<WhatsAppMessage[]> {
		try {
			const rows = getHubDb()
				.query(
					"SELECT * FROM hub_messages WHERE account_id = ? AND timestamp > ? ORDER BY timestamp ASC LIMIT ?;",
				)
				.all(this.accountId, since, limit) as Array<{
				remote_id: string;
				sender_address: string;
				recipient_address: string;
				subject: string | null;
				body: string;
				timestamp: number;
				sender_name: string;
			}>;
			return rows.map((r) => {
				const isGroup = r.sender_address.endsWith("@g.us") || r.recipient_address.endsWith("@g.us");
				return {
					id: r.remote_id,
					from: r.sender_address,
					to: r.recipient_address,
					text: r.body,
					timestamp: r.timestamp,
					senderName: r.sender_name,
					isGroup,
					...(isGroup
						? {
								groupId: r.recipient_address.endsWith("@g.us")
									? r.recipient_address
									: r.sender_address,
								...(r.subject ? { groupName: r.subject } : {}),
							}
						: {}),
				};
			});
		} catch {
			return [];
		}
	}

	async sendMessage(
		to: string,
		text: string,
		replyToMessageId?: string,
	): Promise<{ messageId: string }> {
		if (!this.sock) {
			throw new Error("WhatsApp socket not started or not connected");
		}
		let jid = to;
		if (!jid.includes("@")) {
			const cleanNumber = to.replace(/[^0-9]/g, "");
			jid = `${cleanNumber}@s.whatsapp.net`;
		}
		const options: Record<string, unknown> = {};
		if (replyToMessageId) {
			options.quoted = {
				key: {
					id: replyToMessageId,
					remoteJid: jid,
				},
				message: {
					conversation: "",
				},
			};
		}
		const sent = await this.sock.sendMessage(jid, { text }, options);
		const messageId = sent?.key?.id ?? `wa_${randomUUID()}`;
		return { messageId };
	}
}

// ---------------------------------------------------------------------------
// WhatsApp Connector Core Service
// ---------------------------------------------------------------------------

export class WhatsAppConnector {
	private config: WhatsAppAccountConfig;
	private customClient?: WhatsAppClientInterface;
	private baileysClient?: BaileysWhatsAppClient;
	private lastSyncTimestamp = 0;

	constructor(config: WhatsAppAccountConfig, client?: WhatsAppClientInterface) {
		this.config = config;
		if (client) this.customClient = client;
	}

	private getClient(): WhatsAppClientInterface {
		if (this.customClient) return this.customClient;
		const token = this.config.accessToken ?? this.config.apiKey;
		if (this.config.mode === "cloud" || (this.config.phoneNumberId && token)) {
			return new HttpWhatsAppCloudClient(this.config.phoneNumberId, token, this.config.apiBaseUrl);
		}
		if (!this.baileysClient) {
			this.baileysClient = new BaileysWhatsAppClient(
				this.config.id,
				this.config.name,
				this.config.authDir,
			);
		}
		return this.baileysClient;
	}

	async start(): Promise<void> {
		const client = this.getClient();
		if (client.start) {
			await client.start();
		}
	}

	async stop(): Promise<void> {
		const client = this.getClient();
		if (client.stop) {
			await client.stop();
		}
	}

	async sync(
		options: { force?: boolean } = {},
		database?: Database,
	): Promise<{ syncedCount: number; unreadCount: number }> {
		const db = database ?? getHubDb();
		const client = this.getClient();

		try {
			if (options.force && this.baileysClient && !this.baileysClient.isConnectedStatus()) {
				await this.baileysClient.restart();
			}

			if (this.baileysClient?.syncGroups) {
				try {
					await this.baileysClient.syncGroups();
				} catch (err) {
					log.warn(`Group sync error: ${err}`);
				}
			}

			const messages = await client.fetchMessages(this.lastSyncTimestamp, 100);
			const incomingMessages: Array<Omit<HubMessage, "id">> = [];

			for (const msg of messages) {
				if (!msg.text) continue;

				if (msg.timestamp > this.lastSyncTimestamp) {
					this.lastSyncTimestamp = msg.timestamp;
				}

				const channelRemoteId = msg.groupId || msg.from;
				const channelKind = msg.isGroup ? "group" : "dm";
				const channelName = msg.groupName || msg.senderName || msg.from;

				const channel: HubChannel = {
					id: `wa-${channelRemoteId}`,
					accountId: this.config.id,
					remoteId: channelRemoteId,
					name: channelName,
					kind: channelKind,
					unreadCount: 0,
					lastMessageAt: msg.timestamp,
				};
				saveChannel(channel, db);

				const text = msg.text.trim();
				const snippet = generateMessageSnippet(text);
				const isUrgent = detectMessageUrgency(undefined, text);

				incomingMessages.push({
					accountId: this.config.id,
					remoteId: msg.id,
					channelId: channel.id,
					senderName: msg.senderName || msg.from,
					senderAddress: msg.from,
					recipientAddress: channelName,
					...(msg.groupName ? { subject: msg.groupName } : {}),
					body: text,
					snippet,
					timestamp: msg.timestamp,
					isRead: false,
					isUrgent,
					hasAttachments: false,
					metadata: {
						from: msg.from,
						to: msg.to,
						groupId: msg.groupId,
						groupName: msg.groupName,
						...(msg.replyToMessageId ? { replyToMessageId: msg.replyToMessageId } : {}),
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

			if (this.baileysClient) {
				if (this.baileysClient.isConnectedStatus()) {
					updateAccountStatus(this.config.id, "connected", totalUnread, null, db);
					publishHubAccountStatus({
						accountId: this.config.id,
						status: "connected",
						unreadCount: totalUnread,
					});
				} else {
					void this.baileysClient.ensureActive();
				}
			} else {
				updateAccountStatus(this.config.id, "connected", totalUnread, null, db);
				publishHubAccountStatus({
					accountId: this.config.id,
					status: "connected",
					unreadCount: totalUnread,
				});
			}

			return {
				syncedCount: inserted.length + updated.length,
				unreadCount: totalUnread,
			};
		} catch (err: unknown) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			log.error(`WhatsApp sync error for ${this.config.id}: ${errorMsg}`);
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

	isConnectedStatus(): boolean {
		if (this.baileysClient) {
			return this.baileysClient.isConnectedStatus();
		}
		return true;
	}

	async restart(): Promise<void> {
		if (this.baileysClient) {
			await this.baileysClient.restart();
		}
	}

	async send(params: HubSendMessageParams, database?: Database): Promise<HubSendMessageResult> {
		const db = database ?? getHubDb();
		const client = this.getClient();

		try {
			let target = params.recipient;
			if (params.channelId?.startsWith("wa-")) {
				target = params.channelId.slice(3);
			}

			const sendRes = await client.sendMessage(target, params.body, params.replyToMessageId);

			const id = randomUUID();
			const message: HubMessage = {
				id,
				accountId: this.config.id,
				remoteId: sendRes.messageId,
				...(params.channelId ? { channelId: params.channelId } : {}),
				senderName: this.config.name,
				senderAddress: this.config.phoneNumber ?? `wa:${this.config.id}`,
				recipientAddress: target,
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
			log.error(`WhatsApp send error for ${this.config.id}: ${error}`);
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

export function registerWhatsAppAccount(
	config: WhatsAppAccountConfig,
	client?: WhatsAppClientInterface,
): WhatsAppConnector {
	const connector = new WhatsAppConnector(config, client);

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

	if (!client && config.mode !== "cloud" && !config.phoneNumberId) {
		void connector.start();
	}

	return connector;
}
