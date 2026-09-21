import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { WhatsAppAccountConfig } from "../accounts";
import {
	getChannel,
	getChannels,
	getMessage,
	getMessageByRemoteId,
	getMessages,
	initHubSchema,
	saveAccount,
} from "../db";
import { MockWhatsAppClient, WhatsAppConnector, type WhatsAppMessage } from "./whatsapp";

describe("WhatsApp Connector", () => {
	let db: Database;

	const testConfig: WhatsAppAccountConfig = {
		id: "whatsapp-account-1",
		provider: "whatsapp",
		name: "My WhatsApp",
		enabled: true,
		phoneNumber: "+15551234567",
		phoneNumberId: "phone_num_id_123",
		accessToken: "fake-access-token",
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

	it("processes direct messages and group chats, creating channels and messages in SQLite", async () => {
		const messages: WhatsAppMessage[] = [
			{
				id: "wamid_001",
				from: "+15559876543",
				text: "Hey! Can you please call me asap regarding the contract?",
				timestamp: 1710000000000,
				senderName: "David Client",
				isGroup: false,
			},
			{
				id: "wamid_002",
				from: "+15551112222",
				text: "Design files have been updated for sprint 4.",
				timestamp: 1710000050000,
				senderName: "Design Lead",
				isGroup: true,
				groupId: "12036302@g.us",
				groupName: "Product Sprint Group",
			},
		];

		const mockClient = new MockWhatsAppClient(messages);
		const connector = new WhatsAppConnector(testConfig, mockClient);

		const result = await connector.sync({}, db);
		expect(result.syncedCount).toBe(2);
		expect(result.unreadCount).toBe(2);

		// Channels
		const channels = getChannels(testConfig.id, db);
		expect(channels.length).toBe(2);

		const dmChannel = getChannel("wa-+15559876543", db);
		expect(dmChannel).toBeDefined();
		expect(dmChannel?.name).toBe("David Client");
		expect(dmChannel?.kind).toBe("dm");

		const groupChannel = getChannel("wa-12036302@g.us", db);
		expect(groupChannel).toBeDefined();
		expect(groupChannel?.name).toBe("Product Sprint Group");
		expect(groupChannel?.kind).toBe("group");

		// Messages
		const msg1 = getMessageByRemoteId(testConfig.id, "wamid_001", db);
		expect(msg1).toBeDefined();
		expect(msg1?.senderName).toBe("David Client");
		expect(msg1?.senderAddress).toBe("+15559876543");
		expect(msg1?.body).toContain("call me asap");
		expect(msg1?.isUrgent).toBe(true); // "asap" trigger

		const msg2 = getMessageByRemoteId(testConfig.id, "wamid_002", db);
		expect(msg2).toBeDefined();
		expect(msg2?.senderName).toBe("Design Lead");
		expect(msg2?.recipientAddress).toBe("Product Sprint Group");
		expect(msg2?.isUrgent).toBe(false);
	});

	it("deduplicates messages and avoids duplicates on repeated syncs", async () => {
		const messages: WhatsAppMessage[] = [
			{
				id: "wamid_010",
				from: "+15550009999",
				text: "Coffee tomorrow morning?",
				timestamp: 1710000100000,
				senderName: "Sarah",
			},
		];

		const mockClient = new MockWhatsAppClient(messages);
		const connector = new WhatsAppConnector(testConfig, mockClient);

		const r1 = await connector.sync({}, db);
		expect(r1.syncedCount).toBe(1);

		const r2 = await connector.sync({}, db);
		expect(r2.syncedCount).toBe(0);

		const { total } = getMessages({ accountId: testConfig.id }, db);
		expect(total).toBe(1);
	});

	it("sends outbound messages via WhatsApp client and records in DB", async () => {
		const mockClient = new MockWhatsAppClient();
		const connector = new WhatsAppConnector(testConfig, mockClient);

		const sendRes = await connector.send(
			{
				accountId: testConfig.id,
				recipient: "+15559876543",
				channelId: "wa-+15559876543",
				body: "Calling you right now!",
			},
			db,
		);

		expect(sendRes.success).toBe(true);
		expect(sendRes.messageId).toBeDefined();
		expect(mockClient.sentMessages.length).toBe(1);
		expect(mockClient.sentMessages[0]?.to).toBe("+15559876543");
		expect(mockClient.sentMessages[0]?.text).toBe("Calling you right now!");

		const saved = sendRes.messageId ? getMessage(sendRes.messageId, db) : undefined;
		expect(saved).toBeDefined();
		expect(saved?.recipientAddress).toBe("+15559876543");
		expect(saved?.body).toBe("Calling you right now!");
		expect(saved?.isRead).toBe(true);
	});
});
