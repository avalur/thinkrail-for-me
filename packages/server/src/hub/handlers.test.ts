import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WS_METHODS } from "@thinkrail/contracts";
import { closeHubDb, getHubDb, saveAccount, saveMessage, setHubDbPath } from "./db";
import {
	hubHandlers,
	registerHubAccountSyncer,
	registerHubMessageSender,
	unregisterHubAccountSyncer,
	unregisterHubMessageSender,
} from "./handlers";
import { setHubPublishers } from "./publishers";

function getRequiredHandler(
	method: string,
): (params: unknown, ctx?: unknown) => unknown | Promise<unknown> {
	const handler = hubHandlers[method];
	if (!handler) throw new Error(`Missing handler for ${method}`);
	return handler;
}

describe("Hub RPC Handlers", () => {
	let tempDir: string;
	let dbPath: string;

	let publishedMessages: unknown[] = [];
	let publishedAccountStatuses: unknown[] = [];
	let publishedSyncStatuses: unknown[] = [];

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "tr-hub-handlers-test-"));
		dbPath = join(tempDir, "hub.sqlite");
		setHubDbPath(dbPath);
		getHubDb();

		publishedMessages = [];
		publishedAccountStatuses = [];
		publishedSyncStatuses = [];

		setHubPublishers({
			publishMessage: (m) => publishedMessages.push(m),
			publishAccountStatus: (s) => publishedAccountStatuses.push(s),
			publishSyncStatus: (s) => publishedSyncStatuses.push(s),
		});
	});

	afterEach(() => {
		closeHubDb();
		setHubDbPath(null);
		setHubPublishers({
			publishMessage: () => {},
			publishAccountStatus: () => {},
			publishSyncStatus: () => {},
		});
		unregisterHubMessageSender("telegram");
		unregisterHubAccountSyncer("telegram");
		rmSync(tempDir, { recursive: true, force: true });
	});

	test("hub.getAccounts returns seeded accounts when empty", async () => {
		const handler = getRequiredHandler(WS_METHODS.hubGetAccounts);
		const res = (await handler({})) as { accounts: unknown[] };
		expect(res.accounts.length).toBeGreaterThanOrEqual(5);
	});

	test("hub.getMessages and hub.getDashboardSummary query persisted data", async () => {
		saveAccount({
			id: "acc_test",
			provider: "telegram",
			name: "Telegram Work",
			status: "connected",
			unreadCount: 1,
			lastSyncAt: 1000,
		});

		saveMessage({
			id: "msg_1",
			accountId: "acc_test",
			remoteId: "r1",
			senderName: "Alice",
			senderAddress: "@alice",
			subject: "Deploy meeting",
			body: "Production deployment at 5pm",
			snippet: "Production...",
			timestamp: 2000,
			isRead: false,
			isUrgent: true,
			hasAttachments: false,
		});

		const getMessagesHandler = getRequiredHandler(WS_METHODS.hubGetMessages);
		const messagesRes = (await getMessagesHandler({ query: "deployment" })) as {
			messages: unknown[];
			total: number;
		};
		expect(messagesRes.total).toBe(1);

		const getDashboardHandler = getRequiredHandler(WS_METHODS.hubGetDashboardSummary);
		const dashboardRes = (await getDashboardHandler({})) as {
			totalUnread: number;
			urgentMessages: unknown[];
		};
		expect(dashboardRes.totalUnread).toBe(1);
		expect(dashboardRes.urgentMessages.length).toBe(1);
	});

	test("hub.markRead marks messages as read and publishes account status", async () => {
		saveAccount({
			id: "acc_tg",
			provider: "telegram",
			name: "Telegram",
			status: "connected",
			unreadCount: 1,
			lastSyncAt: null,
		});

		saveMessage({
			id: "msg_unread",
			accountId: "acc_tg",
			remoteId: "r2",
			senderName: "Bob",
			senderAddress: "@bob",
			body: "Hey there",
			snippet: "Hey...",
			timestamp: 1000,
			isRead: false,
			isUrgent: false,
			hasAttachments: false,
		});

		const markReadHandler = getRequiredHandler(WS_METHODS.hubMarkRead);
		const res = (await markReadHandler({ messageIds: ["msg_unread"] })) as {
			ok: boolean;
			modifiedCount: number;
		};
		expect(res.ok).toBe(true);
		expect(res.modifiedCount).toBe(1);

		// Account status was broadcast
		expect(publishedAccountStatuses.length).toBeGreaterThanOrEqual(1);
	});

	test("hub.sendMessage creates local record and triggers publisher", async () => {
		saveAccount({
			id: "acc_email",
			provider: "email_work",
			name: "Work Mail",
			email: "dev@company.com",
			status: "connected",
			unreadCount: 0,
			lastSyncAt: null,
		});

		const sendMessageHandler = getRequiredHandler(WS_METHODS.hubSendMessage);
		const res = (await sendMessageHandler({
			accountId: "acc_email",
			recipient: "boss@company.com",
			subject: "Status update",
			body: "Feature complete and tested.",
		})) as { success: boolean; messageId?: string };

		expect(res.success).toBe(true);
		expect(res.messageId).toBeDefined();
		expect(publishedMessages.length).toBe(1);
	});

	test("hub.sendMessage delegates to custom message sender if registered", async () => {
		saveAccount({
			id: "acc_tg",
			provider: "telegram",
			name: "Telegram",
			status: "connected",
			unreadCount: 0,
			lastSyncAt: null,
		});

		let customSenderCalled = false;
		registerHubMessageSender("telegram", async (_params) => {
			customSenderCalled = true;
			return { success: true, messageId: "tg_sent_123" };
		});

		const sendMessageHandler = getRequiredHandler(WS_METHODS.hubSendMessage);
		const res = (await sendMessageHandler({
			accountId: "acc_tg",
			recipient: "@chat_channel",
			body: "Delegated send test",
		})) as { success: boolean; messageId?: string };

		expect(customSenderCalled).toBe(true);
		expect(res.success).toBe(true);
		expect(res.messageId).toBe("tg_sent_123");
	});

	test("hub.syncNow emits sync statuses and invokes custom syncers", async () => {
		saveAccount({
			id: "acc_tg",
			provider: "telegram",
			name: "Telegram",
			status: "connected",
			unreadCount: 0,
			lastSyncAt: null,
		});

		let syncerInvoked = false;
		registerHubAccountSyncer("telegram", async () => {
			syncerInvoked = true;
			return { synced: true, accountIds: ["acc_tg"] };
		});

		const syncNowHandler = getRequiredHandler(WS_METHODS.hubSyncNow);
		const res = (await syncNowHandler({ accountId: "acc_tg" })) as {
			synced: boolean;
			accountIds?: string[];
		};

		expect(syncerInvoked).toBe(true);
		expect(res.synced).toBe(true);
		expect(res.accountIds).toContain("acc_tg");
		expect(publishedSyncStatuses.length).toBeGreaterThanOrEqual(2);
	});
});
