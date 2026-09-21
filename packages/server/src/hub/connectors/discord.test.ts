import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { DiscordAccountConfig } from "../accounts";
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
	type DiscordChannel,
	DiscordConnector,
	type DiscordMessage,
	MockDiscordClient,
} from "./discord";

describe("Discord Connector", () => {
	let db: Database;

	const testConfig: DiscordAccountConfig = {
		id: "discord-account-1",
		provider: "discord",
		name: "Community Discord",
		enabled: true,
		botToken: "fake-discord-bot-token",
		guildId: "G_123456",
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

	it("processes guild channels and messages including attachments and urgency", async () => {
		const channels: DiscordChannel[] = [
			{
				id: "CH_GENERAL",
				name: "general",
				type: 0, // GUILD_TEXT
				guild_id: "G_123456",
			},
			{
				id: "CH_ANNOUNCE",
				name: "announcements",
				type: 5, // GUILD_ANNOUNCEMENT
				guild_id: "G_123456",
			},
		];

		const messages: DiscordMessage[] = [
			{
				id: "100000000000000001",
				channel_id: "CH_GENERAL",
				author: {
					id: "U_MARK",
					username: "mark_z",
					global_name: "Mark Z",
				},
				content: "Please review the RFC asap before Monday's release.",
				timestamp: "2026-03-22T10:00:00.000Z",
			},
			{
				id: "100000000000000002",
				channel_id: "CH_ANNOUNCE",
				author: {
					id: "U_ADMIN",
					username: "admin",
				},
				content: "New documentation PDF uploaded.",
				timestamp: "2026-03-22T10:05:00.000Z",
				attachments: [
					{
						id: "ATT_1",
						filename: "architecture.pdf",
						size: 1048576,
						url: "https://cdn.discordapp.com/attachments/architecture.pdf",
						content_type: "application/pdf",
					},
				],
			},
		];

		const mockClient = new MockDiscordClient(channels, messages);
		const connector = new DiscordConnector(testConfig, mockClient);

		const result = await connector.sync({}, db);
		expect(result.syncedCount).toBe(2);
		expect(result.unreadCount).toBe(2);

		// Channels
		const dbChannels = getChannels(testConfig.id, db);
		expect(dbChannels.length).toBe(2);

		const genChannel = getChannel("discord-CH_GENERAL", db);
		expect(genChannel).toBeDefined();
		expect(genChannel?.name).toBe("#general");
		expect(genChannel?.kind).toBe("channel");

		// Messages
		const msg1 = getMessageByRemoteId(testConfig.id, "CH_GENERAL:100000000000000001", db);
		expect(msg1).toBeDefined();
		expect(msg1?.senderName).toBe("Mark Z");
		expect(msg1?.senderAddress).toBe("@mark_z");
		expect(msg1?.isUrgent).toBe(true); // "asap" trigger

		const msg2 = getMessageByRemoteId(testConfig.id, "CH_ANNOUNCE:100000000000000002", db);
		expect(msg2).toBeDefined();
		expect(msg2?.hasAttachments).toBe(true);
		expect(msg2?.attachments?.length).toBe(1);
		expect(msg2?.attachments?.[0]?.name).toBe("architecture.pdf");
		expect(msg2?.isUrgent).toBe(false);
	});

	it("deduplicates messages correctly across repeated syncs", async () => {
		const channels: DiscordChannel[] = [
			{ id: "CH_CHAT", name: "chat", type: 0, guild_id: "G_123456" },
		];
		const messages: DiscordMessage[] = [
			{
				id: "100000000000000010",
				channel_id: "CH_CHAT",
				author: { id: "U_LISA", username: "lisa" },
				content: "Hello everyone!",
				timestamp: "2026-03-22T11:00:00.000Z",
			},
		];

		const mockClient = new MockDiscordClient(channels, messages);
		const connector = new DiscordConnector(testConfig, mockClient);

		const r1 = await connector.sync({}, db);
		expect(r1.syncedCount).toBe(1);

		const r2 = await connector.sync({}, db);
		expect(r2.syncedCount).toBe(0);

		const { total } = getMessages({ accountId: testConfig.id }, db);
		expect(total).toBe(1);
	});

	it("sends outbound messages via Discord client and persists in DB", async () => {
		const mockClient = new MockDiscordClient();
		const connector = new DiscordConnector(testConfig, mockClient);

		const sendRes = await connector.send(
			{
				accountId: testConfig.id,
				recipient: "CH_GENERAL",
				channelId: "discord-CH_GENERAL",
				body: "Thanks for the heads up, looking into it now.",
			},
			db,
		);

		expect(sendRes.success).toBe(true);
		expect(sendRes.messageId).toBeDefined();
		expect(mockClient.sentMessages.length).toBe(1);
		expect(mockClient.sentMessages[0]?.channelId).toBe("CH_GENERAL");
		expect(mockClient.sentMessages[0]?.content).toBe(
			"Thanks for the heads up, looking into it now.",
		);

		const saved = sendRes.messageId ? getMessage(sendRes.messageId, db) : undefined;
		expect(saved).toBeDefined();
		expect(saved?.recipientAddress).toBe("CH_GENERAL");
		expect(saved?.body).toBe("Thanks for the heads up, looking into it now.");
		expect(saved?.isRead).toBe(true);
	});
});
