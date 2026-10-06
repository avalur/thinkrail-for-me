import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HubAttachment, HubChannel, HubChannelKind, HubMessage } from "@thinkrail/contracts";
import { logger } from "../log";
import {
	generateMessageSnippet,
	getAccount,
	getHubDb,
	saveAccount,
	saveChannel,
	saveIncomingMessages,
	updateAccountStatus,
} from "./db";
import { publishHubAccountStatus } from "./publishers";

const log = logger("hub:discord-importer");

export interface ImportDiscordPackageOptions {
	packagePath: string;
	accountId?: string;
	database?: Database;
}

export interface ImportDiscordPackageResult {
	success: boolean;
	importedChannels: number;
	importedMessages: number;
	error?: string;
}

interface DiscordExportUser {
	id?: string;
	username?: string;
	global_name?: string;
	discriminator?: string;
	email?: string;
}

interface DiscordExportChannelJson {
	id?: string;
	type?: number;
	name?: string;
	guild?: { id?: string; name?: string };
	recipients?: string[] | Array<{ id: string; username?: string }>;
}

interface DiscordExportMessageJson {
	ID?: string;
	id?: string;
	Timestamp?: string;
	timestamp?: string;
	Contents?: string;
	contents?: string;
	content?: string;
	Attachments?:
		| string
		| Array<{ id?: string; url?: string; filename?: string; size?: number; content_type?: string }>;
	attachments?:
		| string
		| Array<{ id?: string; url?: string; filename?: string; size?: number; content_type?: string }>;
}

export async function importDiscordPackage(
	options: ImportDiscordPackageOptions,
): Promise<ImportDiscordPackageResult> {
	const db = options.database ?? getHubDb();
	const accountId = options.accountId ?? "account_discord";
	const rawPath = options.packagePath.trim();

	if (!rawPath) {
		return {
			success: false,
			importedChannels: 0,
			importedMessages: 0,
			error: "Путь к архиву или папке не указан",
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

	let rootDir = rawPath;
	let tempUnpackDir: string | null = null;

	const stat = statSync(rawPath);
	if (stat.isFile()) {
		// It's a zip archive -> unpack to temporary directory
		tempUnpackDir = join(
			tmpdir(),
			`thinkrail-discord-import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		);
		mkdirSync(tempUnpackDir, { recursive: true });

		try {
			log.info(`Unpacking Discord package archive ${rawPath} to ${tempUnpackDir}...`);
			const proc = Bun.spawnSync(["/usr/bin/unzip", "-q", "-o", rawPath, "-d", tempUnpackDir]);
			if (proc.exitCode !== 0) {
				const errMsg = proc.stderr?.toString() || "Ошибка при распаковке архива unzip";
				return { success: false, importedChannels: 0, importedMessages: 0, error: errMsg };
			}
			rootDir = tempUnpackDir;
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			return {
				success: false,
				importedChannels: 0,
				importedMessages: 0,
				error: `Не удалось распаковать архив: ${errMsg}`,
			};
		}
	}

	try {
		// If rootDir contains a nested single directory (e.g. package/), drill down
		rootDir = locateDiscordPackageRoot(rootDir);

		log.info(`Importing Discord package from root directory: ${rootDir}`);

		// 1. Account info from account/user.json
		let currentUser: DiscordExportUser | null = null;
		const userJsonPath = join(rootDir, "account", "user.json");
		if (existsSync(userJsonPath)) {
			try {
				currentUser = JSON.parse(readFileSync(userJsonPath, "utf-8")) as DiscordExportUser;
				const existingAccount = getAccount(accountId, db);
				if (existingAccount) {
					saveAccount(
						{
							...existingAccount,
							name: currentUser.global_name || currentUser.username || existingAccount.name,
							metadata: {
								...existingAccount.metadata,
								discordUserId: currentUser.id,
								username: currentUser.username,
								source: "data_package",
							},
						},
						db,
					);
				}
			} catch (e) {
				log.warn(`Could not parse user.json: ${e}`);
			}
		}

		// 2. Read messages/index.json (channel ID to channel name mapping)
		const indexMap = new Map<string, string>();
		const indexJsonPath = join(rootDir, "messages", "index.json");
		if (existsSync(indexJsonPath)) {
			try {
				const parsed = JSON.parse(readFileSync(indexJsonPath, "utf-8")) as Record<string, string>;
				for (const [k, v] of Object.entries(parsed)) {
					const cleanId = k.replace(/^c/, "");
					indexMap.set(cleanId, v);
					indexMap.set(k, v);
				}
			} catch (e) {
				log.warn(`Could not parse messages/index.json: ${e}`);
			}
		}

		// 3. Scan messages/ directories
		const messagesDir = join(rootDir, "messages");
		if (!existsSync(messagesDir)) {
			return {
				success: false,
				importedChannels: 0,
				importedMessages: 0,
				error:
					"В архиве не найдена директория 'messages/'. Убедитесь, что выбран корректный Discord Data Package.",
			};
		}

		const entries = readdirSync(messagesDir, { withFileTypes: true });
		const channelDirs = entries.filter(
			(e) => e.isDirectory() && (e.name.startsWith("c") || /^\d+$/.test(e.name)),
		);

		let totalImportedChannels = 0;
		let totalImportedMessages = 0;
		const allIncomingMessages: Array<Omit<HubMessage, "id">> = [];

		const authorName = currentUser?.global_name || currentUser?.username || "You";
		const authorAddress = currentUser?.username ? `@${currentUser.username}` : "@me";

		for (const chEntry of channelDirs) {
			const chDir = join(messagesDir, chEntry.name);
			const cleanChannelId = chEntry.name.replace(/^c/, "");

			let channelName = indexMap.get(cleanChannelId) || indexMap.get(chEntry.name);
			let channelKind: HubChannelKind = "channel";
			const channelMeta: Record<string, unknown> = {};

			const channelJsonPath = join(chDir, "channel.json");
			if (existsSync(channelJsonPath)) {
				try {
					const chJson = JSON.parse(
						readFileSync(channelJsonPath, "utf-8"),
					) as DiscordExportChannelJson;
					if (chJson.name) channelName = chJson.name;
					if (chJson.type === 1 || chJson.type === 3) {
						channelKind = "dm";
					}
					if (chJson.guild?.name) {
						channelMeta.guildName = chJson.guild.name;
						channelMeta.guildId = chJson.guild.id;
					}
				} catch (e) {
					log.warn(`Could not parse channel.json in ${chDir}: ${e}`);
				}
			}

			if (!channelName) {
				channelName = `#channel-${cleanChannelId}`;
			} else if (channelKind === "channel" && !channelName.startsWith("#")) {
				channelName = `#${channelName}`;
			}

			const hubChannel: HubChannel = {
				id: `discord-${cleanChannelId}`,
				accountId,
				remoteId: cleanChannelId,
				name: channelName,
				kind: channelKind,
				unreadCount: 0,
				metadata: channelMeta,
			};
			saveChannel(hubChannel, db);
			totalImportedChannels += 1;

			// Look for messages.json
			const messagesJsonPath = join(chDir, "messages.json");
			if (existsSync(messagesJsonPath)) {
				try {
					const rawMessages = JSON.parse(
						readFileSync(messagesJsonPath, "utf-8"),
					) as DiscordExportMessageJson[];
					if (Array.isArray(rawMessages)) {
						for (const m of rawMessages) {
							const msgId = String(
								m.ID ?? m.id ?? `${cleanChannelId}-${Date.now()}-${Math.random()}`,
							);
							const rawTs = m.Timestamp ?? m.timestamp;
							const timestamp = rawTs ? new Date(rawTs).getTime() : Date.now();
							const content = String(m.Contents ?? m.contents ?? m.content ?? "").trim();

							const rawAtt = m.Attachments ?? m.attachments;
							let attachments: HubAttachment[] = [];
							if (typeof rawAtt === "string" && rawAtt.trim()) {
								attachments = rawAtt
									.split(" ")
									.filter(Boolean)
									.map((url, idx) => ({
										id: `${msgId}-att-${idx}`,
										name: url.split("/").pop() || `file-${idx}`,
										url,
										size: 0,
									}));
							} else if (Array.isArray(rawAtt)) {
								attachments = rawAtt.map((a, idx) => ({
									id: String(a.id ?? `${msgId}-att-${idx}`),
									name: String(a.filename ?? `file-${idx}`),
									url: String(a.url ?? ""),
									size: Number(a.size ?? 0),
									...(a.content_type ? { mimeType: a.content_type } : {}),
								}));
							}

							if (!content && attachments.length === 0) continue;

							const text = content || "(attachment)";
							const snippet = generateMessageSnippet(text);

							allIncomingMessages.push({
								accountId,
								remoteId: `${cleanChannelId}:${msgId}`,
								channelId: hubChannel.id,
								senderName: authorName,
								senderAddress: authorAddress,
								recipientAddress: channelName,
								body: text,
								snippet,
								timestamp,
								isRead: true, // historical messages from personal data package are already read
								isUrgent: false,
								hasAttachments: attachments.length > 0,
								...(attachments.length > 0 ? { attachments } : {}),
								metadata: {
									channelId: cleanChannelId,
									messageId: msgId,
									source: "discord_data_package",
								},
							});
						}
					}
				} catch (e) {
					log.warn(`Could not parse messages.json in ${chDir}: ${e}`);
				}
			}

			// Batch insert every 200 messages to keep memory and transactions lean
			if (allIncomingMessages.length >= 200) {
				const { inserted, updated } = saveIncomingMessages(allIncomingMessages, undefined, db);
				totalImportedMessages += inserted.length + updated.length;
				allIncomingMessages.length = 0;
			}
		}

		if (allIncomingMessages.length > 0) {
			const { inserted, updated } = saveIncomingMessages(allIncomingMessages, undefined, db);
			totalImportedMessages += inserted.length + updated.length;
			allIncomingMessages.length = 0;
		}

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
			`Discord Data Package import finished successfully: ${totalImportedChannels} channels, ${totalImportedMessages} messages`,
		);

		return {
			success: true,
			importedChannels: totalImportedChannels,
			importedMessages: totalImportedMessages,
		};
	} finally {
		if (tempUnpackDir && existsSync(tempUnpackDir)) {
			try {
				rmSync(tempUnpackDir, { recursive: true, force: true });
			} catch (e) {
				log.warn(`Failed to cleanup temp dir ${tempUnpackDir}: ${e}`);
			}
		}
	}
}

function locateDiscordPackageRoot(dir: string): string {
	if (existsSync(join(dir, "messages")) && existsSync(join(dir, "account"))) {
		return dir;
	}
	if (existsSync(join(dir, "messages"))) {
		return dir;
	}
	const subs = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory());
	for (const s of subs) {
		const candidate = join(dir, s.name);
		if (existsSync(join(candidate, "messages"))) {
			return candidate;
		}
	}
	return dir;
}
