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
import { extractTelegramText, importTelegramExport } from "./telegramExportImporter";

describe("Telegram Desktop Export Importer", () => {
	let db: Database;
	let tempDir: string;

	beforeEach(() => {
		db = new Database(":memory:");
		initHubSchema(db);
		saveAccount(
			{
				id: "account_telegram",
				provider: "telegram",
				name: "Telegram",
				status: "disconnected",
				unreadCount: 0,
				lastSyncAt: null,
			},
			db,
		);

		tempDir = join(
			tmpdir(),
			`thinkrail-telegram-test-export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		db.close();
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {}
	});

	it("extracts text correctly from strings and entity arrays", () => {
		expect(extractTelegramText("Simple text")).toBe("Simple text");
		expect(
			extractTelegramText([
				"Hello ",
				{ type: "bold", text: "world" },
				" and ",
				{ type: "code", text: "ThinkRail" },
			]),
		).toBe("Hello world and ThinkRail");
		expect(extractTelegramText(undefined)).toBe("");
	});

	it("imports full account export with multiple chats, text entities, and attachments", async () => {
		const fullExport = {
			about: "Here is your export",
			chats: {
				about: "List of chats",
				list: [
					{
						name: "Architecture & Core Team",
						type: "private_group",
						id: 100234567,
						messages: [
							{
								id: 501,
								type: "message",
								date: "2026-02-10T10:00:00",
								date_unixtimestamp: "1770717600",
								from: "Dmitry",
								from_id: "user991",
								text: [
									"Check out the new ",
									{ type: "bold", text: "MTProto sync architecture" },
									" for Telegram.",
								],
							},
							{
								id: 502,
								type: "message",
								date: "2026-02-10T10:05:00",
								date_unixtimestamp: "1770717900",
								from: "Elena",
								from_id: "user992",
								text: "Looks clean, let's ship it to production asap.",
								reply_to_message_id: 501,
							},
						],
					},
					{
						name: "Alex Dev Direct",
						type: "personal_chat",
						id: 998877,
						messages: [
							{
								id: 601,
								type: "message",
								date: "2026-02-11T12:00:00",
								date_unixtimestamp: "1770811200",
								from: "Support Bot",
								from_id: "user777",
								text: "Your verification code is ready.",
								photo: "chats/chat_02/photos/qr.jpg",
							},
						],
					},
				],
			},
		};

		const resultJsonPath = join(tempDir, "result.json");
		writeFileSync(resultJsonPath, JSON.stringify(fullExport));

		const result = await importTelegramExport({
			exportPath: tempDir,
			accountId: "account_telegram",
			database: db,
		});

		expect(result.success).toBe(true);
		expect(result.importedChannels).toBe(2);
		expect(result.importedMessages).toBe(3);

		// Account updated
		const account = getAccount("account_telegram", db);
		expect(account).toBeDefined();
		expect(account?.status).toBe("connected");

		// Channels
		const channels = getChannels("account_telegram", db);
		expect(channels.length).toBe(2);

		const groupCh = getChannel("tg-100234567", db);
		expect(groupCh).toBeDefined();
		expect(groupCh?.name).toBe("Architecture & Core Team");
		expect(groupCh?.kind).toBe("group");

		const dmCh = getChannel("tg-998877", db);
		expect(dmCh).toBeDefined();
		expect(dmCh?.name).toBe("Alex Dev Direct");
		expect(dmCh?.kind).toBe("dm");

		// Messages
		const msg1 = getMessageByRemoteId("account_telegram", "501", db);
		expect(msg1).toBeDefined();
		expect(msg1?.senderName).toBe("Dmitry");
		expect(msg1?.body).toBe("Check out the new MTProto sync architecture for Telegram.");

		const msg2 = getMessageByRemoteId("account_telegram", "502", db);
		expect(msg2).toBeDefined();
		expect(msg2?.isUrgent).toBe(true); // "asap" trigger
		expect(msg2?.metadata?.replyToMessageId).toBe("501");

		const msg3 = getMessageByRemoteId("account_telegram", "601", db);
		expect(msg3).toBeDefined();
		expect(msg3?.hasAttachments).toBe(true);
		expect(msg3?.attachments?.[0]?.name).toBe("qr.jpg");

		// FTS5 Full text search
		const fts = getMessages({ query: "MTProto", accountId: "account_telegram" }, db);
		expect(fts.total).toBe(1);
		expect(fts.messages[0]?.body).toContain("MTProto sync architecture");
	});

	it("imports single chat export", async () => {
		const singleChatExport = {
			name: "Private Project Chat",
			type: "personal_chat",
			id: 334455,
			messages: [
				{
					id: 101,
					type: "message",
					date: "2026-03-01T15:00:00",
					date_unixtimestamp: "1772377200",
					from: "Collaborator",
					text: "ThinkRail hub is awesome!",
				},
			],
		};

		const singleJsonPath = join(tempDir, "result.json");
		writeFileSync(singleJsonPath, JSON.stringify(singleChatExport));

		const result = await importTelegramExport({
			exportPath: singleJsonPath,
			accountId: "account_telegram",
			database: db,
		});

		expect(result.success).toBe(true);
		expect(result.importedChannels).toBe(1);
		expect(result.importedMessages).toBe(1);

		const ch = getChannel("tg-334455", db);
		expect(ch).toBeDefined();
		expect(ch?.name).toBe("Private Project Chat");

		const msg = getMessageByRemoteId("account_telegram", "101", db);
		expect(msg).toBeDefined();
		expect(msg?.body).toBe("ThinkRail hub is awesome!");
	});

	it("returns descriptive error if result.json is missing or path does not exist", async () => {
		const res1 = await importTelegramExport({
			exportPath: "/nonexistent/path/export",
			database: db,
		});
		expect(res1.success).toBe(false);
		expect(res1.error).toContain("не найден");

		const emptyDir = join(tempDir, "empty");
		mkdirSync(emptyDir, { recursive: true });
		const res2 = await importTelegramExport({
			exportPath: emptyDir,
			database: db,
		});
		expect(res2.success).toBe(false);
		expect(res2.error).toContain("не найден файл result.json");
	});
});
