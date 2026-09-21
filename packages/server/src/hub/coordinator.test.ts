import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	type DiscordAccountConfig,
	type EmailAccountConfig,
	type SlackAccountConfig,
	saveHubAccountConfigs,
	setHubAccountsConfigPath,
	type TelegramAccountConfig,
	type WhatsAppAccountConfig,
} from "./accounts";
import { MockDiscordClient } from "./connectors/discord";
import { MockImapClient } from "./connectors/email";
import { MockSlackClient } from "./connectors/slack";
import { MockTelegramClient } from "./connectors/telegram";
import { MockWhatsAppClient } from "./connectors/whatsapp";
import {
	coordinator,
	isSyncCoordinatorRunning,
	startSyncCoordinator,
	stopSyncCoordinator,
	triggerCoordinatorSync,
} from "./coordinator";
import { getMessages, initHubSchema, setHubDbForTesting } from "./db";

describe("Hub Sync Coordinator", () => {
	const testConfigPath = join(import.meta.dir, `test-coord-accounts-${Date.now()}.json`);
	let db: Database;

	beforeEach(() => {
		setHubAccountsConfigPath(testConfigPath);
		db = new Database(":memory:");
		initHubSchema(db);
		setHubDbForTesting(db);
	});

	afterEach(() => {
		stopSyncCoordinator();
		setHubDbForTesting(null);
		setHubAccountsConfigPath(null);
		if (existsSync(testConfigPath)) {
			try {
				rmSync(testConfigPath, { force: true });
			} catch {
				// ignore
			}
		}
		db.close();
	});

	it("starts and stops properly, updating isRunning status", async () => {
		expect(isSyncCoordinatorRunning()).toBe(false);

		await startSyncCoordinator({ defaultIntervalMs: 10_000 });
		expect(isSyncCoordinatorRunning()).toBe(true);

		stopSyncCoordinator();
		expect(isSyncCoordinatorRunning()).toBe(false);
	});

	it("registers connectors from hub-accounts.json and triggers manual sync", async () => {
		const emailAcc: EmailAccountConfig = {
			id: "coord-email-1",
			provider: "email_work",
			name: "Work Email",
			email: "dev@corp.com",
			enabled: true,
			imap: { host: "imap.corp.com", user: "dev@corp.com" },
		};

		const tgAcc: TelegramAccountConfig = {
			id: "coord-tg-1",
			provider: "telegram",
			name: "Alerts TG",
			enabled: true,
			bot: { botToken: "tok123" },
		};

		const slackAcc: SlackAccountConfig = {
			id: "coord-slack-1",
			provider: "slack",
			name: "Workplace Slack",
			enabled: true,
			botToken: "xoxb-fake",
		};

		const discordAcc: DiscordAccountConfig = {
			id: "coord-discord-1",
			provider: "discord",
			name: "Guild Discord",
			enabled: true,
			botToken: "fake-bot-token",
			channelIds: ["CH_ALERT"],
		};

		const waAcc: WhatsAppAccountConfig = {
			id: "coord-wa-1",
			provider: "whatsapp",
			name: "Ops WhatsApp",
			enabled: true,
			phoneNumber: "+15551234567",
		};

		saveHubAccountConfigs({
			version: 1,
			accounts: [emailAcc, tgAcc, slackAcc, discordAcc, waAcc],
		});

		const mockImap = new MockImapClient([
			{
				seq: 1,
				uid: "9001",
				flags: [],
				headers: {},
				rawRfc822: [
					"From: Admin <admin@corp.com>",
					"Subject: System Notice",
					"Message-ID: <sys-9001@corp.com>",
					"",
					"System update tonight.",
				].join("\r\n"),
			},
		]);

		const mockTg = new MockTelegramClient([
			{
				update_id: 1,
				message: {
					message_id: 4001,
					from: { id: 77, first_name: "Ops" },
					chat: { id: 77, type: "private", first_name: "Ops" },
					date: 1774182000,
					text: "Ping from Ops",
				},
			},
		]);

		const mockSlack = new MockSlackClient(
			[{ id: "C_OPS", name: "ops", is_channel: true }],
			[{ ts: "1710000001.000100", channel: "C_OPS", user: "U_OPS", text: "Slack ops ping" }],
		);

		const mockDiscord = new MockDiscordClient(
			[{ id: "CH_ALERT", name: "alerts", type: 0 }],
			[
				{
					id: "100000000000000001",
					channel_id: "CH_ALERT",
					author: { id: "U_BOT", username: "alertbot" },
					content: "Discord alert ping",
					timestamp: "2026-03-22T10:00:00.000Z",
				},
			],
		);

		const mockWa = new MockWhatsAppClient([
			{
				id: "wa_msg_1",
				from: "+15559876543",
				text: "WhatsApp ops ping",
				timestamp: 1710000000000,
				senderName: "Ops Lead",
			},
		]);

		await startSyncCoordinator();
		// Register custom test clients onto coordinator
		coordinator.registerConnector(emailAcc, { email: { imap: mockImap } });
		coordinator.registerConnector(tgAcc, { telegram: mockTg });
		coordinator.registerConnector(slackAcc, { slack: mockSlack });
		coordinator.registerConnector(discordAcc, { discord: mockDiscord });
		coordinator.registerConnector(waAcc, { whatsapp: mockWa });

		const syncRes = await triggerCoordinatorSync();
		expect(syncRes.synced).toBe(true);
		expect(syncRes.accountIds).toContain("coord-email-1");
		expect(syncRes.accountIds).toContain("coord-tg-1");
		expect(syncRes.accountIds).toContain("coord-slack-1");
		expect(syncRes.accountIds).toContain("coord-discord-1");
		expect(syncRes.accountIds).toContain("coord-wa-1");

		const { total: emailTotal } = getMessages({ accountId: "coord-email-1" }, db);
		expect(emailTotal).toBe(1);

		const { total: tgTotal } = getMessages({ accountId: "coord-tg-1" }, db);
		expect(tgTotal).toBe(1);

		const { total: slackTotal } = getMessages({ accountId: "coord-slack-1" }, db);
		expect(slackTotal).toBe(1);

		const { total: discordTotal } = getMessages({ accountId: "coord-discord-1" }, db);
		expect(discordTotal).toBe(1);

		const { total: waTotal } = getMessages({ accountId: "coord-wa-1" }, db);
		expect(waTotal).toBe(1);
	});
});
