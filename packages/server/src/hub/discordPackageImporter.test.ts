import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getAccount,
	getChannel,
	getChannels,
	getMessageByRemoteId,
	getMessages,
	initHubSchema,
	saveAccount,
} from "./db";
import { importDiscordPackage } from "./discordPackageImporter";

describe("Discord Data Package Importer", () => {
	let db: Database;
	let tempDir: string;

	beforeEach(() => {
		db = new Database(":memory:");
		initHubSchema(db);
		saveAccount(
			{
				id: "account_discord",
				provider: "discord",
				name: "Discord",
				status: "disconnected",
				unreadCount: 0,
				lastSyncAt: null,
			},
			db,
		);

		tempDir = join(
			tmpdir(),
			`thinkrail-discord-test-pkg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		db.close();
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {}
	});

	it("imports user info, channels, DMs, attachments, and populates FTS5", async () => {
		// 1. Create account/user.json
		const accountDir = join(tempDir, "account");
		mkdirSync(accountDir, { recursive: true });
		writeFileSync(
			join(accountDir, "user.json"),
			JSON.stringify({
				id: "123456789012345678",
				username: "alex_dev",
				global_name: "Alex Avdiushenko",
				email: "alex@example.com",
			}),
		);

		// 2. Create messages/index.json
		const messagesDir = join(tempDir, "messages");
		mkdirSync(messagesDir, { recursive: true });
		writeFileSync(
			join(messagesDir, "index.json"),
			JSON.stringify({
				c101: "general-chat",
				c102: "Direct Message with Team Lead",
			}),
		);

		// 3. Create messages/c101 (guild text channel)
		const c101Dir = join(messagesDir, "c101");
		mkdirSync(c101Dir, { recursive: true });
		writeFileSync(
			join(c101Dir, "channel.json"),
			JSON.stringify({
				id: "101",
				type: 0,
				name: "general-chat",
				guild: { id: "G999", name: "Engineering Hub" },
			}),
		);
		writeFileSync(
			join(c101Dir, "messages.json"),
			JSON.stringify([
				{
					ID: "900000000000000001",
					Timestamp: "2025-11-20 14:30:00",
					Contents: "Discussion on SQLite FTS5 migration performance.",
					Attachments: "https://cdn.discord.com/attachments/spec.pdf",
				},
				{
					ID: "900000000000000002",
					Timestamp: "2025-11-20 14:35:00",
					Contents: "Agreed, let's proceed with Bun sqlite WAL mode.",
				},
			]),
		);

		// 4. Create messages/c102 (DM channel)
		const c102Dir = join(messagesDir, "c102");
		mkdirSync(c102Dir, { recursive: true });
		writeFileSync(
			join(c102Dir, "channel.json"),
			JSON.stringify({
				id: "102",
				type: 1,
				recipients: ["555666777"],
			}),
		);
		writeFileSync(
			join(c102Dir, "messages.json"),
			JSON.stringify([
				{
					ID: "900000000000000003",
					Timestamp: "2025-11-21 09:00:00",
					Contents: "Morning, send me the ThinkRail control panel links.",
				},
			]),
		);

		const result = await importDiscordPackage({
			packagePath: tempDir,
			accountId: "account_discord",
			database: db,
		});

		expect(result.success).toBe(true);
		expect(result.importedChannels).toBe(2);
		expect(result.importedMessages).toBe(3);

		// Account updated
		const account = getAccount("account_discord", db);
		expect(account).toBeDefined();
		expect(account?.name).toBe("Alex Avdiushenko");
		expect(account?.status).toBe("connected");

		// Channels created
		const channels = getChannels("account_discord", db);
		expect(channels.length).toBe(2);

		const generalCh = getChannel("discord-101", db);
		expect(generalCh).toBeDefined();
		expect(generalCh?.name).toBe("#general-chat");
		expect(generalCh?.kind).toBe("channel");
		expect(generalCh?.metadata?.guildName).toBe("Engineering Hub");

		const dmCh = getChannel("discord-102", db);
		expect(dmCh).toBeDefined();
		expect(dmCh?.kind).toBe("dm");

		// Messages and attachments
		const msg1 = getMessageByRemoteId("account_discord", "101:900000000000000001", db);
		expect(msg1).toBeDefined();
		expect(msg1?.body).toBe("Discussion on SQLite FTS5 migration performance.");
		expect(msg1?.hasAttachments).toBe(true);
		expect(msg1?.attachments?.[0]?.url).toBe("https://cdn.discord.com/attachments/spec.pdf");
		expect(msg1?.senderName).toBe("Alex Avdiushenko");

		// Full-text search FTS5 verification
		const ftsHits = getMessages({ query: "FTS5", accountId: "account_discord" }, db);
		expect(ftsHits.total).toBeGreaterThanOrEqual(1);
		expect(ftsHits.messages[0]?.body).toContain("FTS5");

		const ftsHits2 = getMessages({ query: "ThinkRail", accountId: "account_discord" }, db);
		expect(ftsHits2.total).toBe(1);
		expect(ftsHits2.messages[0]?.body).toContain("ThinkRail");
	});

	it("returns error if path does not exist", async () => {
		const res = await importDiscordPackage({
			packagePath: "/non/existent/path/package.zip",
			database: db,
		});
		expect(res.success).toBe(false);
		expect(res.error).toContain("не найден");
	});
});
