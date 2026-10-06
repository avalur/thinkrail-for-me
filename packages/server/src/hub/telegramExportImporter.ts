import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	HubAttachment,
	HubChannel,
	HubChannelKind,
	HubImportTelegramExportParams,
	HubImportTelegramExportResult,
	HubMessage,
} from "@thinkrail/contracts";
import { logger } from "../log";
import {
	detectMessageUrgency,
	generateMessageSnippet,
	getAccount,
	getHubDb,
	saveAccount,
	saveChannel,
	saveIncomingMessages,
	updateAccountStatus,
} from "./db";
import { publishHubAccountStatus } from "./publishers";

const log = logger("hub:telegram-importer");

export interface ImportTelegramExportOptions extends HubImportTelegramExportParams {
	database?: Database;
}

export type ImportTelegramExportResult = HubImportTelegramExportResult;

interface TelegramExportTextEntity {
	type?: string;
	text?: string;
}

interface TelegramExportMessage {
	id: number | string;
	type?: string;
	date?: string;
	date_unixtimestamp?: string | number;
	from?: string;
	from_id?: string | number;
	text?: string | Array<string | TelegramExportTextEntity>;
	reply_to_message_id?: number | string;
	photo?: string;
	file?: string;
	file_name?: string;
	media_type?: string;
	mime_type?: string;
}

interface TelegramExportChat {
	name?: string;
	type?: string;
	id?: number | string;
	messages?: TelegramExportMessage[];
}

interface TelegramExportResultJson {
	about?: string;
	name?: string;
	type?: string;
	id?: number | string;
	messages?: TelegramExportMessage[];
	chats?: {
		about?: string;
		list?: TelegramExportChat[];
	};
}

export function extractTelegramText(
	textVal: string | Array<string | TelegramExportTextEntity> | undefined | null,
): string {
	if (!textVal) return "";
	if (typeof textVal === "string") return textVal;
	if (Array.isArray(textVal)) {
		return textVal
			.map((item) => {
				if (typeof item === "string") return item;
				if (item && typeof item === "object" && typeof item.text === "string") {
					return item.text;
				}
				return "";
			})
			.join("");
	}
	return String(textVal);
}

function mapTelegramChatTypeToKind(type?: string): HubChannelKind {
	switch (type) {
		case "personal_chat":
		case "bot_chat":
			return "dm";
		case "private_group":
		case "public_supergroup":
			return "group";
		case "public_channel":
		case "private_channel":
			return "channel";
		default:
			return "group";
	}
}

function findResultJsonFile(dir: string, depth = 0): string | null {
	if (depth > 4) return null;
	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isFile() && entry.name.toLowerCase() === "result.json") {
				return join(dir, entry.name);
			}
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				const found = findResultJsonFile(join(dir, entry.name), depth + 1);
				if (found) return found;
			}
		}
	} catch {
		return null;
	}
	return null;
}

export async function importTelegramExport(
	options: ImportTelegramExportOptions,
): Promise<ImportTelegramExportResult> {
	const db = options.database ?? getHubDb();
	const accountId = options.accountId ?? "account_telegram";
	const rawPath = options.exportPath.trim();

	if (!rawPath) {
		return {
			success: false,
			importedChannels: 0,
			importedMessages: 0,
			error: "Путь к архиву или файлу экспорта Telegram не указан",
		};
	}

	if (!existsSync(rawPath)) {
		return {
			success: false,
			importedChannels: 0,
			importedMessages: 0,
			error: `Файл или папка не найдены: ${rawPath}`,
		};
	}

	let jsonFilePath: string | null = null;
	let tempUnpackDir: string | null = null;

	try {
		const stat = statSync(rawPath);
		if (stat.isFile()) {
			if (rawPath.toLowerCase().endsWith(".json")) {
				jsonFilePath = rawPath;
			} else {
				// Treat as ZIP archive
				tempUnpackDir = join(
					tmpdir(),
					`thinkrail-telegram-import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				);
				mkdirSync(tempUnpackDir, { recursive: true });

				log.info(`Unpacking Telegram export archive ${rawPath} to ${tempUnpackDir}...`);
				const proc = Bun.spawnSync(["/usr/bin/unzip", "-q", "-o", rawPath, "-d", tempUnpackDir]);
				if (proc.exitCode !== 0) {
					const errMsg = proc.stderr?.toString() || "Ошибка при распаковке ZIP-архива unzip";
					return { success: false, importedChannels: 0, importedMessages: 0, error: errMsg };
				}
				jsonFilePath = findResultJsonFile(tempUnpackDir);
			}
		} else if (stat.isDirectory()) {
			jsonFilePath = findResultJsonFile(rawPath);
		}

		if (!jsonFilePath || !existsSync(jsonFilePath)) {
			return {
				success: false,
				importedChannels: 0,
				importedMessages: 0,
				error: "В указанном файле или папке не найден файл result.json от Telegram Desktop",
			};
		}

		log.info(`Reading Telegram export JSON from ${jsonFilePath}...`);
		const rawContent = readFileSync(jsonFilePath, "utf8");
		const data = JSON.parse(rawContent) as TelegramExportResultJson;

		let chatsToProcess: TelegramExportChat[] = [];

		if (data.chats?.list && Array.isArray(data.chats.list)) {
			// Full account export
			chatsToProcess = data.chats.list;
		} else if (Array.isArray(data.messages)) {
			// Single chat export
			chatsToProcess = [
				{
					name: data.name ?? "Telegram Exported Chat",
					type: data.type ?? "personal_chat",
					id: data.id ?? 1,
					messages: data.messages,
				},
			];
		}

		if (chatsToProcess.length === 0) {
			return {
				success: false,
				importedChannels: 0,
				importedMessages: 0,
				error: "В файле result.json не найдено чатов или сообщений",
			};
		}

		// Ensure account exists in DB
		const existingAccount = getAccount(accountId, db);
		if (!existingAccount) {
			saveAccount(
				{
					id: accountId,
					provider: "telegram",
					name: "Telegram",
					status: "connected",
					unreadCount: 0,
					lastSyncAt: Date.now(),
				},
				db,
			);
		}

		let totalImportedChannels = 0;
		let totalImportedMessages = 0;

		for (const chat of chatsToProcess) {
			const remoteChatId = chat.id !== undefined && chat.id !== null ? String(chat.id) : "";
			const chatName = chat.name || (remoteChatId ? `Chat ${remoteChatId}` : "Telegram Chat");
			const channelId = remoteChatId ? `tg-${remoteChatId}` : `tg-imported-${Date.now()}`;
			const kind = mapTelegramChatTypeToKind(chat.type);

			const channel: HubChannel = {
				id: channelId,
				accountId,
				remoteId: remoteChatId || channelId,
				name: chatName,
				kind,
				unreadCount: 0,
				lastMessageAt: Date.now(),
				metadata: {
					exportedType: chat.type,
					importedFrom: "Telegram Desktop Export",
				},
			};

			saveChannel(channel, db);
			totalImportedChannels++;

			const rawMessages = chat.messages || [];
			const messagesToSave: HubMessage[] = [];

			for (const rawMsg of rawMessages) {
				// Skip non-message service events (e.g. "service")
				if (rawMsg.type && rawMsg.type !== "message") {
					continue;
				}

				let text = extractTelegramText(rawMsg.text);
				const hasMedia = Boolean(rawMsg.photo || rawMsg.file);
				if (!text.trim() && hasMedia) {
					text = rawMsg.file_name
						? `[File: ${rawMsg.file_name}]`
						: rawMsg.photo
							? "[Photo]"
							: "[Attachment]";
				}

				if (!text.trim() && !hasMedia) {
					continue;
				}

				let timestamp = Date.now();
				if (rawMsg.date_unixtimestamp) {
					timestamp = Number(rawMsg.date_unixtimestamp) * 1000;
				} else if (rawMsg.date) {
					const parsed = new Date(rawMsg.date).getTime();
					if (!Number.isNaN(parsed)) {
						timestamp = parsed;
					}
				}

				const senderName = rawMsg.from || chatName;
				const senderAddress =
					rawMsg.from_id !== undefined && rawMsg.from_id !== null
						? String(rawMsg.from_id)
						: rawMsg.from || chatName;

				const attachments: HubAttachment[] = [];
				if (rawMsg.photo) {
					attachments.push({
						id: `att-photo-${rawMsg.id}`,
						name: rawMsg.photo.split("/").pop() || "photo.jpg",
						mimeType: "image/jpeg",
					});
				}
				if (rawMsg.file) {
					attachments.push({
						id: `att-file-${rawMsg.id}`,
						name: rawMsg.file_name || rawMsg.file.split("/").pop() || "file",
						mimeType: rawMsg.mime_type || "application/octet-stream",
					});
				}

				const snippet = generateMessageSnippet(text);
				const isUrgent = detectMessageUrgency(undefined, text);

				messagesToSave.push({
					id: randomUUID(),
					accountId,
					remoteId: String(rawMsg.id),
					channelId: channel.id,
					senderName,
					senderAddress,
					recipientAddress: remoteChatId,
					body: text,
					snippet,
					timestamp,
					isRead: true, // Imported archive messages are marked read
					isUrgent,
					hasAttachments: attachments.length > 0,
					...(attachments.length > 0 ? { attachments } : {}),
					metadata: {
						chatId: remoteChatId,
						chatName,
						...(rawMsg.reply_to_message_id
							? { replyToMessageId: String(rawMsg.reply_to_message_id) }
							: {}),
					},
				});
			}

			if (messagesToSave.length > 0) {
				const { inserted, updated } = saveIncomingMessages(messagesToSave, undefined, db);
				totalImportedMessages += inserted.length + updated.length;
			}
		}

		// Update unread count and status
		const unreadRow = db
			.query("SELECT COUNT(*) as count FROM hub_messages WHERE account_id = ? AND is_read = 0;")
			.get(accountId) as { count: number } | null;
		const totalUnread = unreadRow?.count ?? 0;

		updateAccountStatus(accountId, "connected", totalUnread, null, db);
		publishHubAccountStatus({
			accountId,
			status: "connected",
			unreadCount: totalUnread,
		});

		log.info(
			`Imported ${totalImportedChannels} channels and ${totalImportedMessages} messages from Telegram export into ${accountId}.`,
		);

		return {
			success: true,
			importedChannels: totalImportedChannels,
			importedMessages: totalImportedMessages,
		};
	} catch (err) {
		const errMsg = err instanceof Error ? err.message : String(err);
		log.error(`Failed to import Telegram export: ${errMsg}`);
		return {
			success: false,
			importedChannels: 0,
			importedMessages: 0,
			error: errMsg,
		};
	} finally {
		if (tempUnpackDir && existsSync(tempUnpackDir)) {
			try {
				rmSync(tempUnpackDir, { recursive: true, force: true });
			} catch (e) {
				log.warn(`Failed to clean up temp dir ${tempUnpackDir}: ${e}`);
			}
		}
	}
}
