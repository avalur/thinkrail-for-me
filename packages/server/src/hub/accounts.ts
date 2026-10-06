import type { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { HubAccount, HubAccountProvider } from "@thinkrail/contracts";
import { logger } from "../log";
import { dataDir } from "../persistence";
import { getAccount, getAccounts, getHubDb, saveAccount } from "./db";

const log = logger("hub:accounts");

export interface BaseAccountConfig {
	id: string;
	provider: HubAccountProvider;
	name: string;
	enabled?: boolean;
	syncIntervalMs?: number;
}

export interface EmailImapConfig {
	host: string;
	port?: number;
	tls?: boolean;
	user: string;
	password?: string;
	mailbox?: string;
}

export interface EmailSmtpConfig {
	host: string;
	port?: number;
	tls?: boolean;
	user?: string;
	password?: string;
}

export interface EmailAccountConfig extends BaseAccountConfig {
	provider: "email_work" | "email_personal";
	email: string;
	imap: EmailImapConfig;
	smtp?: EmailSmtpConfig;
}

export interface TelegramBotConfig {
	botToken: string;
	chatId?: string | number;
	apiBaseUrl?: string;
}

export interface TelegramMtprotoConfig {
	apiId?: number;
	apiHash?: string;
	sessionString?: string;
	phone?: string;
	password?: string;
	twoFactorPassword?: string;
}

export interface TelegramAccountConfig extends BaseAccountConfig {
	provider: "telegram";
	bot?: TelegramBotConfig;
	botToken?: string;
	mtproto?: TelegramMtprotoConfig;
	twoFactorPassword?: string;
	password?: string;
	authDir?: string;
	pollIntervalMs?: number;
}

export interface SlackAccountConfig extends BaseAccountConfig {
	provider: "slack";
	botToken?: string;
	userToken?: string;
	apiBaseUrl?: string;
	channelIds?: string[];
	pollIntervalMs?: number;
}

export interface DiscordAccountConfig extends BaseAccountConfig {
	provider: "discord";
	botToken?: string;
	userToken?: string;
	webhookUrl?: string;
	guildId?: string;
	channelIds?: string[];
	apiBaseUrl?: string;
	pollIntervalMs?: number;
}

export interface WhatsAppAccountConfig extends BaseAccountConfig {
	provider: "whatsapp";
	mode?: "baileys" | "cloud";
	phoneNumber?: string;
	apiKey?: string;
	accessToken?: string;
	phoneNumberId?: string;
	apiBaseUrl?: string;
	sessionData?: string;
	authDir?: string;
	pollIntervalMs?: number;
}

export interface GenericAccountConfig extends BaseAccountConfig {
	provider: HubAccountProvider;
	email?: string;
	credentials?: Record<string, unknown>;
	settings?: Record<string, unknown>;
}

export type HubAccountConfig =
	| EmailAccountConfig
	| TelegramAccountConfig
	| SlackAccountConfig
	| DiscordAccountConfig
	| WhatsAppAccountConfig
	| GenericAccountConfig;

export interface HubAccountsConfigFile {
	version: number;
	accounts: HubAccountConfig[];
}

let customConfigPath: string | null = null;

export function getHubAccountsConfigPath(): string {
	if (customConfigPath) return customConfigPath;
	return join(dataDir(), "hub-accounts.json");
}

export function setHubAccountsConfigPath(path: string | null): void {
	customConfigPath = path;
}

export function loadHubAccountConfigs(): HubAccountsConfigFile {
	const filePath = getHubAccountsConfigPath();
	if (!existsSync(filePath)) {
		return { version: 1, accounts: [] };
	}

	try {
		const raw = readFileSync(filePath, "utf8");
		const parsed = JSON.parse(raw) as Partial<HubAccountsConfigFile>;
		if (Array.isArray(parsed.accounts)) {
			return {
				version: parsed.version ?? 1,
				accounts: parsed.accounts as HubAccountConfig[],
			};
		}
		return { version: 1, accounts: [] };
	} catch (err) {
		log.warn(`Failed to parse hub-accounts.json at ${filePath}: ${err}`);
		return { version: 1, accounts: [] };
	}
}

export function seedDefaultAccountConfigsIfEmpty(): HubAccountsConfigFile {
	const current = loadHubAccountConfigs();
	if (current.accounts.length > 0) return current;

	const defaultConfigs: HubAccountsConfigFile = {
		version: 1,
		accounts: [
			{
				id: "account_telegram",
				provider: "telegram",
				name: "Telegram",
				enabled: false,
			},
			{
				id: "account_email_work",
				provider: "email_work",
				name: "Work Email",
				enabled: false,
			},
			{
				id: "account_email_personal",
				provider: "email_personal",
				name: "Personal Email",
				enabled: false,
			},
			{
				id: "account_slack",
				provider: "slack",
				name: "Slack",
				enabled: false,
			},
			{
				id: "account_discord",
				provider: "discord",
				name: "Discord",
				enabled: false,
			},
			{
				id: "account_whatsapp",
				provider: "whatsapp",
				name: "WhatsApp",
				enabled: true,
			},
		],
	};
	try {
		saveHubAccountConfigs(defaultConfigs);
	} catch {}
	return defaultConfigs;
}

export function saveHubAccountConfigs(config: HubAccountsConfigFile): void {
	const filePath = getHubAccountsConfigPath();
	const dir = dirname(filePath);
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	}

	const content = JSON.stringify(config, null, 2);
	writeFileSync(filePath, content, { encoding: "utf8", mode: 0o600 });
	try {
		chmodSync(filePath, 0o600);
	} catch {
		// Ignore chmod errors on filesystems that do not support POSIX chmod
	}
}

export function getAccountConfig(id: string): HubAccountConfig | undefined {
	const file = loadHubAccountConfigs();
	return file.accounts.find((a) => a.id === id);
}

export function saveAccountConfig(accountConfig: HubAccountConfig): void {
	const file = loadHubAccountConfigs();
	const index = file.accounts.findIndex((a) => a.id === accountConfig.id);
	if (index >= 0) {
		file.accounts[index] = accountConfig;
	} else {
		file.accounts.push(accountConfig);
	}
	saveHubAccountConfigs(file);
}

export function deleteAccountConfig(id: string): boolean {
	const file = loadHubAccountConfigs();
	const initialLen = file.accounts.length;
	file.accounts = file.accounts.filter((a) => a.id !== id);
	if (file.accounts.length !== initialLen) {
		saveHubAccountConfigs(file);
		return true;
	}
	return false;
}

export function syncAccountsFromConfigToDb(database?: Database): HubAccount[] {
	const db = database ?? getHubDb();
	const config = loadHubAccountConfigs();

	for (const acc of config.accounts) {
		const email = "email" in acc ? (acc.email as string | undefined) : undefined;
		let initialStatus: HubAccount["status"] = "disconnected";
		let initialError: string | undefined;

		if (acc.enabled === false) {
			initialStatus = "disconnected";
		} else if (acc.provider === "whatsapp") {
			const existing = getAccount(acc.id, db);
			initialStatus = existing?.status ?? "connecting";
		} else if (acc.provider === "discord") {
			const dAcc = acc as DiscordAccountConfig;
			const hasCreds =
				Boolean(dAcc.botToken) ||
				Boolean(dAcc.userToken) ||
				Boolean(process.env.DISCORD_BOT_TOKEN) ||
				Boolean(process.env.DISCORD_USER_TOKEN);
			if (hasCreds) {
				const existing = getAccount(acc.id, db);
				initialStatus = existing?.status ?? "connecting";
			} else {
				initialStatus = "disconnected";
				initialError = "Требуется токен Discord (Bot Token или User Token)";
			}
		} else if (acc.provider === "telegram") {
			const tAcc = acc as TelegramAccountConfig;
			const hasCreds = Boolean(tAcc.bot?.botToken) || Boolean(tAcc.mtproto?.phone);
			if (hasCreds) {
				const existing = getAccount(acc.id, db);
				initialStatus = existing?.status ?? "connecting";
			} else {
				initialStatus = "disconnected";
				initialError = "Требуется токен Telegram";
			}
		} else {
			const existing = getAccount(acc.id, db);
			initialStatus = existing?.status ?? "connected";
		}

		const existing = getAccount(acc.id, db);
		saveAccount(
			{
				id: acc.id,
				provider: acc.provider,
				name: acc.name,
				...(email ? { email } : {}),
				status: initialStatus,
				unreadCount: existing?.unreadCount ?? 0,
				lastSyncAt: existing?.lastSyncAt ?? null,
				...(existing?.metadata ? { metadata: existing.metadata } : {}),
				...(initialError
					? { error: initialError }
					: existing?.error
						? { error: existing.error }
						: {}),
			},
			db,
		);
	}

	return getAccounts(undefined, db);
}
