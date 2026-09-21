import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { SlackAccountConfig } from "../accounts";
import {
	getChannel,
	getChannels,
	getMessage,
	getMessageByRemoteId,
	getMessages,
	initHubSchema,
	saveAccount,
} from "../db";
import {
	MockSlackClient,
	SlackConnector,
	type SlackConversation,
	type SlackMessage,
} from "./slack";

describe("Slack Connector", () => {
	let db: Database;

	const testConfig: SlackAccountConfig = {
		id: "slack-account-1",
		provider: "slack",
		name: "Workplace Slack",
		enabled: true,
		botToken: "xoxb-fake-slack-token",
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

	it("processes channels and direct messages, creating channels and messages in DB", async () => {
		const conversations: SlackConversation[] = [
			{
				id: "C_DEV",
				name: "dev-announcements",
				is_channel: true,
			},
			{
				id: "D_ALICE",
				user: "alice",
				is_im: true,
			},
		];

		const messages: SlackMessage[] = [
			{
				ts: "1710000100.000100",
				channel: "C_DEV",
				user: "U_BOB",
				username: "bob",
				text: "Production release v2.4 is live!",
			},
			{
				ts: "1710000200.000200",
				channel: "D_ALICE",
				user: "U_ALICE",
				username: "alice",
				text: "Hey! Urgent: can you verify the database migration script asap?",
			},
		];

		const mockClient = new MockSlackClient(conversations, messages);
		const connector = new SlackConnector(testConfig, mockClient);

		const result = await connector.sync({}, db);
		expect(result.syncedCount).toBe(2);
		expect(result.unreadCount).toBe(2);

		// Verify channels
		const channels = getChannels(testConfig.id, db);
		expect(channels.length).toBe(2);

		const devChannel = getChannel("slack-C_DEV", db);
		expect(devChannel).toBeDefined();
		expect(devChannel?.kind).toBe("channel");
		expect(devChannel?.name).toBe("#dev-announcements");

		const imChannel = getChannel("slack-D_ALICE", db);
		expect(imChannel).toBeDefined();
		expect(imChannel?.kind).toBe("dm");
		expect(imChannel?.name).toBe("@alice");

		// Verify messages
		const msg1 = getMessageByRemoteId(testConfig.id, "C_DEV:1710000100.000100", db);
		expect(msg1).toBeDefined();
		expect(msg1?.senderName).toBe("bob");
		expect(msg1?.senderAddress).toBe("@U_BOB");
		expect(msg1?.body).toContain("Production release");
		expect(msg1?.isUrgent).toBe(false);

		const msg2 = getMessageByRemoteId(testConfig.id, "D_ALICE:1710000200.000200", db);
		expect(msg2).toBeDefined();
		expect(msg2?.senderName).toBe("alice");
		expect(msg2?.isUrgent).toBe(true); // "Urgent" & "asap" keyword triggers
	});

	it("handles deduplication and does not duplicate messages on repeated syncs", async () => {
		const conversations: SlackConversation[] = [
			{ id: "C_GENERAL", name: "general", is_channel: true },
		];
		const messages: SlackMessage[] = [
			{
				ts: "1710000500.000100",
				channel: "C_GENERAL",
				user: "U_CHARLIE",
				text: "Welcome to the team!",
			},
		];

		const mockClient = new MockSlackClient(conversations, messages);
		const connector = new SlackConnector(testConfig, mockClient);

		const res1 = await connector.sync({}, db);
		expect(res1.syncedCount).toBe(1);

		const res2 = await connector.sync({}, db);
		expect(res2.syncedCount).toBe(0);

		const { total } = getMessages({ accountId: testConfig.id }, db);
		expect(total).toBe(1);
	});

	it("sends outbound messages via Slack client and records them in DB", async () => {
		const mockClient = new MockSlackClient();
		const connector = new SlackConnector(testConfig, mockClient);

		const sendRes = await connector.send(
			{
				accountId: testConfig.id,
				recipient: "C_DEV",
				channelId: "slack-C_DEV",
				body: "Deployment verified and approved.",
			},
			db,
		);

		expect(sendRes.success).toBe(true);
		expect(sendRes.messageId).toBeDefined();
		expect(mockClient.sentMessages.length).toBe(1);
		expect(mockClient.sentMessages[0]?.channelId).toBe("C_DEV");
		expect(mockClient.sentMessages[0]?.text).toBe("Deployment verified and approved.");

		const saved = sendRes.messageId ? getMessage(sendRes.messageId, db) : undefined;
		expect(saved).toBeDefined();
		expect(saved?.recipientAddress).toBe("C_DEV");
		expect(saved?.body).toBe("Deployment verified and approved.");
		expect(saved?.isRead).toBe(true);
	});
});
