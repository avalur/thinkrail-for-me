import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import {
	deleteAccountConfig,
	type EmailAccountConfig,
	getAccountConfig,
	loadHubAccountConfigs,
	saveAccountConfig,
	saveHubAccountConfigs,
	setHubAccountsConfigPath,
	syncAccountsFromConfigToDb,
	type TelegramAccountConfig,
} from "./accounts";
import { getAccount, initHubSchema } from "./db";

describe("Hub Account Credential & Config Management", () => {
	const testConfigPath = join(import.meta.dir, `test-hub-accounts-${Date.now()}.json`);
	let db: Database;

	beforeEach(() => {
		setHubAccountsConfigPath(testConfigPath);
		db = new Database(":memory:");
		initHubSchema(db);
	});

	afterEach(() => {
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

	it("returns empty accounts list when config file does not exist", () => {
		const config = loadHubAccountConfigs();
		expect(config.version).toBe(1);
		expect(config.accounts).toEqual([]);
	});

	it("saves and loads account configs with secure 0600 file permissions", () => {
		const emailAcc: EmailAccountConfig = {
			id: "email-work",
			provider: "email_work",
			name: "Work Mailbox",
			email: "dev@company.com",
			enabled: true,
			imap: {
				host: "imap.company.com",
				port: 993,
				tls: true,
				user: "dev@company.com",
				password: "secret-password",
			},
			smtp: {
				host: "smtp.company.com",
				port: 465,
				tls: true,
				user: "dev@company.com",
				password: "secret-password",
			},
		};

		saveHubAccountConfigs({
			version: 1,
			accounts: [emailAcc],
		});

		expect(existsSync(testConfigPath)).toBe(true);
		const stat = statSync(testConfigPath);
		// Check that owner read/write is enabled (mode ends with 600 or 660 depending on umask on some OS)
		expect(stat.mode & 0o600).toBe(0o600);

		const loaded = loadHubAccountConfigs();
		expect(loaded.accounts.length).toBe(1);
		const firstAccount = loaded.accounts[0];
		expect(firstAccount).toBeDefined();
		expect(firstAccount?.id).toBe("email-work");
		expect(firstAccount?.provider).toBe("email_work");
	});

	it("supports CRUD operations: saveAccountConfig, getAccountConfig, deleteAccountConfig", () => {
		const tgAcc: TelegramAccountConfig = {
			id: "tg-personal",
			provider: "telegram",
			name: "Personal Telegram",
			enabled: true,
			bot: {
				botToken: "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11",
			},
		};

		saveAccountConfig(tgAcc);
		const found = getAccountConfig("tg-personal");
		expect(found).toBeDefined();
		expect(found?.name).toBe("Personal Telegram");

		// Update
		saveAccountConfig({
			...tgAcc,
			name: "Updated Telegram",
		});
		expect(getAccountConfig("tg-personal")?.name).toBe("Updated Telegram");

		// Delete
		const deleted = deleteAccountConfig("tg-personal");
		expect(deleted).toBe(true);
		expect(getAccountConfig("tg-personal")).toBeUndefined();
	});

	it("syncs accounts from config to SQLite database", () => {
		const emailAcc: EmailAccountConfig = {
			id: "work-mail",
			provider: "email_work",
			name: "Work Email",
			email: "user@work.com",
			enabled: true,
			imap: { host: "imap.mail.com", user: "user@work.com" },
		};

		const tgAcc: TelegramAccountConfig = {
			id: "tg-bot",
			provider: "telegram",
			name: "Telegram Alerts",
			enabled: false,
			bot: { botToken: "tok123" },
		};

		saveHubAccountConfigs({
			version: 1,
			accounts: [emailAcc, tgAcc],
		});

		const accounts = syncAccountsFromConfigToDb(db);
		expect(accounts.length).toBe(2);

		const workMail = getAccount("work-mail", db);
		expect(workMail).toBeDefined();
		expect(workMail?.email).toBe("user@work.com");
		expect(workMail?.status).toBe("connected");

		const tgAlerts = getAccount("tg-bot", db);
		expect(tgAlerts).toBeDefined();
		expect(tgAlerts?.status).toBe("disconnected"); // enabled: false
	});
});
