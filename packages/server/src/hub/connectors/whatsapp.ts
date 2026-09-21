import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type {
	HubChannel,
	HubMessage,
	HubSendMessageParams,
	HubSendMessageResult,
} from "@thinkrail/contracts";
import { logger } from "../../log";
import type { WhatsAppAccountConfig } from "../accounts";
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

// ---------------------------------------------------------------------------
// WhatsApp Connector Core Service
// ---------------------------------------------------------------------------

export class WhatsAppConnector {
	private config: WhatsAppAccountConfig;
	private customClient?: WhatsAppClientInterface;
	private lastSyncTimestamp = 0;

	constructor(config: WhatsAppAccountConfig, client?: WhatsAppClientInterface) {
		this.config = config;
		if (client) this.customClient = client;
	}

	private getClient(): WhatsAppClientInterface {
		if (this.customClient) return this.customClient;
		const token = this.config.accessToken ?? this.config.apiKey;
		return new HttpWhatsAppCloudClient(this.config.phoneNumberId, token, this.config.apiBaseUrl);
	}

	async sync(
		_options: { force?: boolean } = {},
		database?: Database,
	): Promise<{ syncedCount: number; unreadCount: number }> {
		const db = database ?? getHubDb();
		const client = this.getClient();

		try {
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
