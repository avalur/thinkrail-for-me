import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { TelegramAccountConfig } from "../accounts";
import {
	getChannel,
	getChannels,
	getMessage,
	getMessageByRemoteId,
	getMessages,
	initHubSchema,
	saveAccount,
} from "../db";
import { MockTelegramClient, TelegramConnector, type TelegramUpdate } from "./telegram";

describe("Telegram Connector", () => {
	let db: Database;

	const testConfig: TelegramAccountConfig = {
		id: "tg-account-1",
		provider: "telegram",
		name: "My Telegram",
		enabled: true,
		bot: {
			botToken: "123456:FAKE_TOKEN_FOR_TESTS",
		},
	};

	beforeEach(() => {
		db = new Database(":memory:");
		initHubSchema(db);
		saveAccount(
			{
				id: testConfig.id,
				provider: testConfig.provider,
				name: testConfig.name,
				status: "connected",
				unreadCount: 0,
				lastSyncAt: null,
			},
			db,
		);
	});

	afterEach(() => {
		db.close();
	});

	it("processes private messages, groups, and channel posts, creating channels and messages", async () => {
		const updates: TelegramUpdate[] = [
			{
				update_id: 1,
				message: {
					message_id: 501,
					from: {
						id: 991,
						first_name: "Dmitry",
						username: "dmitry_dev",
					},
					chat: {
						id: 991,
						type: "private",
						first_name: "Dmitry",
						username: "dmitry_dev",
					},
					date: 1774180000,
					text: "Hey, can you review the deploy script asap?",
				},
			},
			{
				update_id: 2,
				channel_post: {
					message_id: 801,
					chat: {
						id: -1001234567,
						type: "channel",
						title: "DevOps Announcements",
					},
					date: 1774180500,
					text: "Cluster maintenance scheduled for tonight at 23:00 UTC.",
				},
			},
		];

		const mockClient = new MockTelegramClient(updates);
		const connector = new TelegramConnector(testConfig, mockClient);

		const result = await connector.sync({}, db);
		expect(result.syncedCount).toBe(2);
		expect(result.unreadCount).toBe(2);

		// Channels created
		const channels = getChannels(testConfig.id, db);
		expect(channels.length).toBe(2);

		const privateChannel = getChannel("tg-991", db);
		expect(privateChannel).toBeDefined();
		expect(privateChannel?.kind).toBe("dm");
		expect(privateChannel?.name).toBe("Dmitry");

		const broadcastChannel = getChannel("tg--1001234567", db);
		expect(broadcastChannel).toBeDefined();
		expect(broadcastChannel?.kind).toBe("channel");
		expect(broadcastChannel?.name).toBe("DevOps Announcements");

		// Messages created
		const msg1 = getMessageByRemoteId(testConfig.id, "501", db);
		expect(msg1).toBeDefined();
		expect(msg1?.senderName).toBe("Dmitry");
		expect(msg1?.senderAddress).toBe("@dmitry_dev");
		expect(msg1?.body).toContain("review the deploy script");
		expect(msg1?.isUrgent).toBe(true); // "asap" trigger

		const msg2 = getMessageByRemoteId(testConfig.id, "801", db);
		expect(msg2).toBeDefined();
		expect(msg2?.senderName).toBe("DevOps Announcements");
		expect(msg2?.body).toContain("Cluster maintenance");
		expect(msg2?.isUrgent).toBe(false);
	});

	it("handles deduplication and does not duplicate messages on repeated syncs", async () => {
		const updates: TelegramUpdate[] = [
			{
				update_id: 1,
				message: {
					message_id: 601,
					from: { id: 111, first_name: "Elena" },
					chat: { id: 111, type: "private", first_name: "Elena" },
					date: 1774181000,
					text: "Good morning!",
				},
			},
		];

		const mockClient = new MockTelegramClient(updates);
		const connector = new TelegramConnector(testConfig, mockClient);

		// First sync
		const res1 = await connector.sync({}, db);
		expect(res1.syncedCount).toBe(1);

		// Second sync with no new updates
		const res2 = await connector.sync({}, db);
		expect(res2.syncedCount).toBe(0);

		const { total } = getMessages({ accountId: testConfig.id }, db);
		expect(total).toBe(1);
	});

	it("sends outbound messages via Telegram client and records them in DB", async () => {
		const mockClient = new MockTelegramClient();
		const connector = new TelegramConnector(testConfig, mockClient);

		const sendRes = await connector.send(
			{
				accountId: testConfig.id,
				recipient: "991",
				channelId: "tg-991",
				body: "Reviewed and approved!",
			},
			db,
		);

		expect(sendRes.success).toBe(true);
		expect(sendRes.messageId).toBeDefined();
		expect(mockClient.sentMessages.length).toBe(1);
		expect(mockClient.sentMessages[0]?.chatId).toBe("991");
		expect(mockClient.sentMessages[0]?.text).toBe("Reviewed and approved!");

		const saved = sendRes.messageId ? getMessage(sendRes.messageId, db) : undefined;
		expect(saved).toBeDefined();
		expect(saved?.recipientAddress).toBe("991");
		expect(saved?.body).toBe("Reviewed and approved!");
		expect(saved?.isRead).toBe(true);
	});
});
