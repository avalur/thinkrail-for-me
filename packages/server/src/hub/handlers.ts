import { randomUUID } from "node:crypto";
import {
	type HubAccount,
	type HubAccountProvider,
	type HubFilter,
	type HubMarkReadParams,
	type HubMessage,
	type HubSendMessageParams,
	type HubSendMessageResult,
	type HubSubmitTelegramPasswordParams,
	type HubSyncNowParams,
	type HubSyncNowResult,
	WS_METHODS,
} from "@thinkrail/contracts";
import {
	getAccountConfig,
	type HubAccountConfig,
	saveAccountConfig,
	syncAccountsFromConfigToDb,
	type TelegramAccountConfig,
} from "./accounts";
import { reloadCoordinatorAccount, submitCoordinatorTelegramPassword } from "./coordinator";
import {
	getAccount,
	getAccounts,
	getChannels,
	getDashboardSummary,
	getMessages,
	markMessagesRead,
	saveMessage,
	seedDefaultAccountsIfEmpty,
} from "./db";
import { importDiscordPackage } from "./discordPackageImporter";
import { publishHubAccountStatus, publishHubMessage, publishHubSyncStatus } from "./publishers";
import { importTelegramExport } from "./telegramExportImporter";

export type HubMessageSender = (params: HubSendMessageParams) => Promise<HubSendMessageResult>;
export type HubAccountSyncer = (params: HubSyncNowParams) => Promise<HubSyncNowResult>;

const hubMessageSenders = new Map<string, HubMessageSender>();
const hubAccountSyncers = new Map<string, HubAccountSyncer>();

export function registerHubMessageSender(key: string, sender: HubMessageSender): void {
	hubMessageSenders.set(key, sender);
}

export function unregisterHubMessageSender(key: string): void {
	hubMessageSenders.delete(key);
}

export function registerHubAccountSyncer(key: string, syncer: HubAccountSyncer): void {
	hubAccountSyncers.set(key, syncer);
}

export function unregisterHubAccountSyncer(key: string): void {
	hubAccountSyncers.delete(key);
}

export async function sendHubMessage(params: HubSendMessageParams): Promise<HubSendMessageResult> {
	if (!params.accountId || !params.recipient || !params.body) {
		return {
			success: false,
			error: "Missing required fields: accountId, recipient, body",
		};
	}

	const account = getAccount(params.accountId);
	if (!account) {
		return {
			success: false,
			error: `Account not found: ${params.accountId}`,
		};
	}

	// Check if specialized sender connector is registered
	const customSender =
		hubMessageSenders.get(params.accountId) ?? hubMessageSenders.get(account.provider);
	if (customSender) {
		return customSender(params);
	}

	// Default local record creation
	const id = randomUUID();
	const message: HubMessage = {
		id,
		accountId: account.id,
		remoteId: `out-${randomUUID()}`,
		...(params.channelId ? { channelId: params.channelId } : {}),
		senderName: account.name,
		senderAddress: account.email ?? account.name,
		recipientAddress: params.recipient,
		...(params.subject ? { subject: params.subject } : {}),
		body: params.body,
		snippet: params.body.slice(0, 150),
		timestamp: Date.now(),
		isRead: true,
		isUrgent: false,
		hasAttachments: false,
		...(params.replyToMessageId ? { metadata: { replyToMessageId: params.replyToMessageId } } : {}),
	};

	saveMessage(message);
	publishHubMessage(message);

	return {
		success: true,
		messageId: id,
	};
}

export const hubHandlers: Record<
	string,
	(params: unknown, ctx?: unknown) => unknown | Promise<unknown>
> = {
	[WS_METHODS.hubGetAccounts]: (params) => {
		const p = (params ?? {}) as { provider?: HubAccountProvider };
		let accounts = getAccounts(p.provider);
		if (accounts.length === 0 && !p.provider) {
			accounts = seedDefaultAccountsIfEmpty();
		}
		return { accounts };
	},

	[WS_METHODS.hubGetChannels]: (params) => {
		const p = (params ?? {}) as { accountId?: string };
		return { channels: getChannels(p.accountId) };
	},

	[WS_METHODS.hubGetMessages]: (params) => {
		const p = (params ?? {}) as HubFilter;
		return getMessages(p);
	},

	[WS_METHODS.hubGetDashboardSummary]: () => {
		return getDashboardSummary();
	},

	[WS_METHODS.hubMarkRead]: (params) => {
		const p = (params ?? {}) as HubMarkReadParams;
		const modifiedCount = markMessagesRead(p);

		// Broadcast updated account status if unread count changed
		if (modifiedCount > 0) {
			const accounts = getAccounts();
			for (const acc of accounts) {
				publishHubAccountStatus({
					accountId: acc.id,
					status: acc.status,
					unreadCount: acc.unreadCount,
				});
			}
		}

		return { ok: true as const, modifiedCount };
	},

	[WS_METHODS.hubSendMessage]: async (params) => {
		return sendHubMessage((params ?? {}) as HubSendMessageParams);
	},

	[WS_METHODS.hubSyncNow]: async (params) => {
		const p = (params ?? {}) as HubSyncNowParams;
		publishHubSyncStatus({
			...(p.accountId ? { accountId: p.accountId } : {}),
			isSyncing: true,
			progress: "Sync initiated...",
		});

		try {
			// Check if specialized syncer connector is registered
			const targetAccounts = p.accountId
				? [getAccount(p.accountId)].filter((a): a is HubAccount => a !== null)
				: getAccounts();

			const accountIds: string[] = [];

			for (const acc of targetAccounts) {
				accountIds.push(acc.id);
				const customSyncer = hubAccountSyncers.get(acc.id) ?? hubAccountSyncers.get(acc.provider);
				if (customSyncer) {
					await customSyncer({
						accountId: acc.id,
						...(p.force !== undefined ? { force: p.force } : {}),
						...(p.backfill !== undefined ? { backfill: p.backfill } : {}),
						...(p.backfillLimit !== undefined ? { backfillLimit: p.backfillLimit } : {}),
					});
				}
			}

			publishHubSyncStatus({
				...(p.accountId ? { accountId: p.accountId } : {}),
				isSyncing: false,
				progress: "Sync complete",
			});

			return {
				synced: true,
				accountIds,
			};
		} catch (err: unknown) {
			const error = err instanceof Error ? err.message : String(err);
			publishHubSyncStatus({
				...(p.accountId ? { accountId: p.accountId } : {}),
				isSyncing: false,
				error,
			});
			return {
				synced: false,
				error,
			};
		}
	},

	[WS_METHODS.hubSaveAccountConfig]: async (params) => {
		const p = (params ?? {}) as { accountId?: string; config?: Record<string, unknown> };
		if (!p.accountId || !p.config) {
			return { success: false, error: "Missing accountId or config" };
		}
		const existingConfig = getAccountConfig(p.accountId);
		if (!existingConfig) {
			return { success: false, error: `Account not found: ${p.accountId}` };
		}
		const updatedConfig: HubAccountConfig = {
			...existingConfig,
			...p.config,
			id: p.accountId,
			provider: existingConfig.provider,
		} as HubAccountConfig;

		saveAccountConfig(updatedConfig);
		syncAccountsFromConfigToDb();
		reloadCoordinatorAccount(p.accountId);

		// If a 2FA/cloud password was provided, forward it directly to the connector
		const submittedPassword = p.config.twoFactorPassword ?? p.config.password;
		if (submittedPassword && typeof submittedPassword === "string") {
			submitCoordinatorTelegramPassword(p.accountId, submittedPassword);
		}

		// Trigger immediate sync
		const customSyncer =
			hubAccountSyncers.get(p.accountId) ?? hubAccountSyncers.get(existingConfig.provider);
		if (customSyncer) {
			void customSyncer({ accountId: p.accountId, force: true });
		}

		const updatedAccount = getAccount(p.accountId);
		return {
			success: true,
			account: updatedAccount ?? undefined,
		};
	},

	[WS_METHODS.hubSubmitTelegramPassword]: async (params) => {
		const p = (params ?? {}) as HubSubmitTelegramPasswordParams;
		if (!p.password) {
			return { ok: false, status: "error", error: "Не указан пароль" };
		}
		const accountId = p.accountId ?? "account_telegram";

		const handled = submitCoordinatorTelegramPassword(accountId, p.password);

		// Also persist password to account config so reconnects remember it
		const existingConfig = getAccountConfig(accountId);
		if (existingConfig && existingConfig.provider === "telegram") {
			const tgConfig = existingConfig as TelegramAccountConfig;
			saveAccountConfig({
				...tgConfig,
				twoFactorPassword: p.password,
				password: p.password,
				mtproto: {
					...(tgConfig.mtproto || {}),
					twoFactorPassword: p.password,
					password: p.password,
				},
			});
		}

		return {
			ok: true,
			status: handled ? "password_submitted" : "saved_for_next_scan",
			waitingForScan: !handled,
		};
	},

	[WS_METHODS.hubImportDiscordPackage]: async (params) => {
		const p = (params ?? {}) as { packagePath?: string; accountId?: string };
		if (!p.packagePath) {
			return {
				success: false,
				importedChannels: 0,
				importedMessages: 0,
				error: "Не указан путь packagePath",
			};
		}
		return importDiscordPackage({
			packagePath: p.packagePath,
			accountId: p.accountId ?? "account_discord",
		});
	},

	[WS_METHODS.hubImportTelegramExport]: async (params) => {
		const p = (params ?? {}) as { exportPath?: string; accountId?: string };
		if (!p.exportPath) {
			return {
				success: false,
				importedChannels: 0,
				importedMessages: 0,
				error: "Не указан путь exportPath",
			};
		}
		return importTelegramExport({
			exportPath: p.exportPath,
			accountId: p.accountId ?? "account_telegram",
		});
	},
};
