import type { HubSyncNowResult } from "@thinkrail/contracts";
import { logger } from "../log";
import {
	type DiscordAccountConfig,
	type EmailAccountConfig,
	type HubAccountConfig,
	loadHubAccountConfigs,
	type SlackAccountConfig,
	syncAccountsFromConfigToDb,
	type TelegramAccountConfig,
	type WhatsAppAccountConfig,
} from "./accounts";
import {
	type DiscordClientInterface,
	type DiscordConnector,
	registerDiscordAccount,
} from "./connectors/discord";
import {
	type EmailConnector,
	type ImapClientInterface,
	registerEmailAccount,
	type SmtpClientInterface,
} from "./connectors/email";
import {
	registerSlackAccount,
	type SlackClientInterface,
	type SlackConnector,
} from "./connectors/slack";
import {
	registerTelegramAccount,
	type TelegramClientInterface,
	type TelegramConnector,
} from "./connectors/telegram";
import {
	registerWhatsAppAccount,
	type WhatsAppClientInterface,
	type WhatsAppConnector,
} from "./connectors/whatsapp";
import { unregisterHubAccountSyncer, unregisterHubMessageSender } from "./handlers";
import { publishHubSyncStatus } from "./publishers";

const log = logger("hub:coordinator");

export const DEFAULT_POLL_INTERVAL_MS = 60_000;

class HubSyncCoordinator {
	private running = false;
	private accountTimers = new Map<string, ReturnType<typeof setInterval>>();
	private syncingAccounts = new Set<string>();
	private emailConnectors = new Map<string, EmailConnector>();
	private telegramConnectors = new Map<string, TelegramConnector>();
	private slackConnectors = new Map<string, SlackConnector>();
	private discordConnectors = new Map<string, DiscordConnector>();
	private whatsappConnectors = new Map<string, WhatsAppConnector>();

	isRunning(): boolean {
		return this.running;
	}

	async start(
		options: { autoSyncOnStart?: boolean; defaultIntervalMs?: number } = {},
	): Promise<void> {
		if (this.running) return;
		this.running = true;
		log.info("Starting Hub sync coordinator...");

		try {
			// Sync file configuration to database
			syncAccountsFromConfigToDb();
		} catch (err) {
			log.warn(`Could not sync account configs to DB: ${err}`);
		}

		// Initialize connectors and schedule polling
		this.setupConnectorsAndTimers(options.defaultIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);

		if (options.autoSyncOnStart) {
			void this.triggerSync();
		}
	}

	stop(): void {
		if (!this.running) return;
		this.running = false;
		log.info("Stopping Hub sync coordinator...");

		for (const timer of this.accountTimers.values()) {
			clearInterval(timer);
		}
		this.accountTimers.clear();
		this.syncingAccounts.clear();

		// Cleanup registered handlers
		for (const id of this.emailConnectors.keys()) {
			unregisterHubAccountSyncer(id);
			unregisterHubMessageSender(id);
		}
		for (const id of this.telegramConnectors.keys()) {
			unregisterHubAccountSyncer(id);
			unregisterHubMessageSender(id);
		}
		for (const id of this.slackConnectors.keys()) {
			unregisterHubAccountSyncer(id);
			unregisterHubMessageSender(id);
		}
		for (const id of this.discordConnectors.keys()) {
			unregisterHubAccountSyncer(id);
			unregisterHubMessageSender(id);
		}
		for (const id of this.whatsappConnectors.keys()) {
			unregisterHubAccountSyncer(id);
			unregisterHubMessageSender(id);
		}

		this.emailConnectors.clear();
		this.telegramConnectors.clear();
		this.slackConnectors.clear();
		this.discordConnectors.clear();
		this.whatsappConnectors.clear();
	}

	setupConnectorsAndTimers(defaultIntervalMs: number): void {
		const configFile = loadHubAccountConfigs();

		for (const acc of configFile.accounts) {
			if (acc.enabled === false) continue;
			this.registerConnector(acc);

			const interval =
				("pollIntervalMs" in acc && acc.pollIntervalMs ? acc.pollIntervalMs : acc.syncIntervalMs) ??
				defaultIntervalMs;

			this.scheduleAccountPolling(acc.id, interval);
		}
	}

	registerConnector(
		acc: HubAccountConfig,
		customClients?: {
			email?: { imap?: ImapClientInterface; smtp?: SmtpClientInterface };
			telegram?: TelegramClientInterface;
			slack?: SlackClientInterface;
			discord?: DiscordClientInterface;
			whatsapp?: WhatsAppClientInterface;
		},
	): void {
		if (acc.provider === "email_work" || acc.provider === "email_personal") {
			const conn = registerEmailAccount(acc as EmailAccountConfig, customClients?.email);
			this.emailConnectors.set(acc.id, conn);
		} else if (acc.provider === "telegram") {
			const conn = registerTelegramAccount(acc as TelegramAccountConfig, customClients?.telegram);
			this.telegramConnectors.set(acc.id, conn);
		} else if (acc.provider === "slack") {
			const conn = registerSlackAccount(acc as SlackAccountConfig, customClients?.slack);
			this.slackConnectors.set(acc.id, conn);
		} else if (acc.provider === "discord") {
			const conn = registerDiscordAccount(acc as DiscordAccountConfig, customClients?.discord);
			this.discordConnectors.set(acc.id, conn);
		} else if (acc.provider === "whatsapp") {
			const conn = registerWhatsAppAccount(acc as WhatsAppAccountConfig, customClients?.whatsapp);
			this.whatsappConnectors.set(acc.id, conn);
		}
	}

	scheduleAccountPolling(accountId: string, intervalMs: number): void {
		const existingTimer = this.accountTimers.get(accountId);
		if (existingTimer) {
			clearInterval(existingTimer);
		}

		const timer = setInterval(() => {
			void this.syncAccount(accountId);
		}, intervalMs);

		this.accountTimers.set(accountId, timer);
	}

	async syncAccount(accountId: string, force = false): Promise<boolean> {
		if (this.syncingAccounts.has(accountId) && !force) {
			return false;
		}

		this.syncingAccounts.add(accountId);
		try {
			const emailConn = this.emailConnectors.get(accountId);
			if (emailConn) {
				await emailConn.sync();
				return true;
			}

			const tgConn = this.telegramConnectors.get(accountId);
			if (tgConn) {
				await tgConn.sync();
				return true;
			}

			const slackConn = this.slackConnectors.get(accountId);
			if (slackConn) {
				await slackConn.sync();
				return true;
			}

			const discordConn = this.discordConnectors.get(accountId);
			if (discordConn) {
				await discordConn.sync();
				return true;
			}

			const waConn = this.whatsappConnectors.get(accountId);
			if (waConn) {
				await waConn.sync();
				return true;
			}

			return false;
		} catch (err) {
			log.error(`Background sync failed for account ${accountId}: ${err}`);
			return false;
		} finally {
			this.syncingAccounts.delete(accountId);
		}
	}

	async triggerSync(accountId?: string, force = false): Promise<HubSyncNowResult> {
		publishHubSyncStatus({
			...(accountId ? { accountId } : {}),
			isSyncing: true,
			progress: "Manual sync started...",
		});

		try {
			const targetAccounts = accountId
				? [accountId]
				: [
						...this.emailConnectors.keys(),
						...this.telegramConnectors.keys(),
						...this.slackConnectors.keys(),
						...this.discordConnectors.keys(),
						...this.whatsappConnectors.keys(),
					];

			const syncedIds: string[] = [];
			for (const id of targetAccounts) {
				const ok = await this.syncAccount(id, force);
				if (ok) syncedIds.push(id);
			}

			publishHubSyncStatus({
				...(accountId ? { accountId } : {}),
				isSyncing: false,
				progress: "Sync complete",
			});

			return {
				synced: true,
				accountIds: syncedIds,
			};
		} catch (err: unknown) {
			const error = err instanceof Error ? err.message : String(err);
			publishHubSyncStatus({
				...(accountId ? { accountId } : {}),
				isSyncing: false,
				error,
			});
			return {
				synced: false,
				error,
			};
		}
	}
}

export const coordinator = new HubSyncCoordinator();

export function startSyncCoordinator(options?: {
	autoSyncOnStart?: boolean;
	defaultIntervalMs?: number;
}): Promise<void> {
	return coordinator.start(options);
}

export function stopSyncCoordinator(): void {
	coordinator.stop();
}

export function isSyncCoordinatorRunning(): boolean {
	return coordinator.isRunning();
}

export function triggerCoordinatorSync(
	accountId?: string,
	force?: boolean,
): Promise<HubSyncNowResult> {
	return coordinator.triggerSync(accountId, force);
}
