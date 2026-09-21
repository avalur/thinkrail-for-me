import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { HubAccount, HubAgentTask, HubChannel, HubMessage } from "@thinkrail/contracts";
import {
	closeHubDb,
	deleteAccount,
	deleteAgentTask,
	deleteChannel,
	deleteMessage,
	getAccount,
	getAgentTask,
	getAgentTasks,
	getChannel,
	getChannels,
	getDashboardSummary,
	getHubDb,
	getMessage,
	getMessages,
	initHubSchema,
	markMessagesRead,
	recalculateUnreadCounts,
	saveAccount,
	saveAgentTask,
	saveChannel,
	saveMessage,
	saveMessages,
	seedDefaultAccountsIfEmpty,
	updateAccountStatus,
	updateAgentTaskStatus,
} from "./db";

describe("Hub SQLite DB Layer", () => {
	let db: Database;

	beforeEach(() => {
		db = getHubDb(":memory:");
	});

	afterEach(() => {
		closeHubDb(db);
	});

	test("initializes schema and runs idempotent migrations", () => {
		initHubSchema(db);
		const migrationRow = db.query("SELECT MAX(version) as ver FROM hub_migrations;").get() as {
			ver: number;
		};
		expect(migrationRow.ver).toBeGreaterThanOrEqual(1);

		// Re-running initHubSchema should be idempotent and not fail
		expect(() => initHubSchema(db)).not.toThrow();
	});

	describe("Account CRUD & Seeding", () => {
		test("seeds default accounts when database is empty", () => {
			const accounts = seedDefaultAccountsIfEmpty(db);
			expect(accounts.length).toBeGreaterThanOrEqual(5);

			const providers = accounts.map((a) => a.provider);
			expect(providers).toContain("telegram");
			expect(providers).toContain("email_work");
			expect(providers).toContain("email_personal");
			expect(providers).toContain("slack");
			expect(providers).toContain("discord");
		});

		test("creates, reads, updates status and deletes accounts", () => {
			const acc: HubAccount = {
				id: "acc_test",
				provider: "email_work",
				name: "Work Mail",
				email: "dev@company.com",
				status: "connected",
				unreadCount: 3,
				lastSyncAt: 123456789,
				metadata: { folder: "INBOX" },
			};
			saveAccount(acc, db);

			const fetched = getAccount("acc_test", db);
			expect(fetched).not.toBeNull();
			expect(fetched?.name).toBe("Work Mail");
			expect(fetched?.email).toBe("dev@company.com");
			expect(fetched?.unreadCount).toBe(3);
			expect(fetched?.metadata).toEqual({ folder: "INBOX" });

			updateAccountStatus("acc_test", "error", 5, "Authentication failed", db);
			const updated = getAccount("acc_test", db);
			expect(updated?.status).toBe("error");
			expect(updated?.unreadCount).toBe(5);
			expect(updated?.error).toBe("Authentication failed");

			expect(deleteAccount("acc_test", db)).toBe(true);
			expect(deleteAccount("acc_test", db)).toBe(false);
			expect(getAccount("acc_test", db)).toBeNull();
		});
	});

	describe("Channel CRUD", () => {
		beforeEach(() => {
			saveAccount(
				{
					id: "acc_slack",
					provider: "slack",
					name: "Slack Work",
					status: "connected",
					unreadCount: 0,
					lastSyncAt: null,
				},
				db,
			);
		});

		test("creates, lists, and deletes channels", () => {
			const ch: HubChannel = {
				id: "ch_general",
				accountId: "acc_slack",
				remoteId: "C12345",
				name: "general",
				kind: "channel",
				unreadCount: 2,
				lastMessageAt: 1000,
			};
			saveChannel(ch, db);

			const fetched = getChannel("ch_general", db);
			expect(fetched?.name).toBe("general");
			expect(fetched?.kind).toBe("channel");

			const channels = getChannels("acc_slack", db);
			expect(channels.length).toBe(1);
			expect(channels[0]?.id).toBe("ch_general");

			expect(deleteChannel("ch_general", db)).toBe(true);
			expect(getChannel("ch_general", db)).toBeNull();
		});
	});

	describe("Message CRUD, Deduplication, and Filtering", () => {
		beforeEach(() => {
			saveAccount(
				{
					id: "acc_work",
					provider: "email_work",
					name: "Work Mail",
					status: "connected",
					unreadCount: 0,
					lastSyncAt: null,
				},
				db,
			);
			saveAccount(
				{
					id: "acc_tg",
					provider: "telegram",
					name: "Telegram",
					status: "connected",
					unreadCount: 0,
					lastSyncAt: null,
				},
				db,
			);
		});

		test("saves messages and handles deduplication/upsert correctly", () => {
			const msg: HubMessage = {
				id: "m1",
				accountId: "acc_work",
				remoteId: "r1",
				senderName: "Alice",
				senderAddress: "alice@company.com",
				subject: "Project Status",
				body: "All tests passing",
				snippet: "All tests...",
				timestamp: 2000,
				isRead: false,
				isUrgent: true,
				hasAttachments: false,
			};

			saveMessage(msg, db);
			expect(getMessage("m1", db)?.subject).toBe("Project Status");

			// Upsert updated message
			saveMessage(
				{
					...msg,
					subject: "Project Status - Updated",
					body: "All tests passing and deployed",
				},
				db,
			);

			const updated = getMessage("m1", db);
			expect(updated?.subject).toBe("Project Status - Updated");
			expect(updated?.body).toBe("All tests passing and deployed");
		});

		test("batch saves messages with saveMessages", () => {
			const msgs: HubMessage[] = [
				{
					id: "b1",
					accountId: "acc_tg",
					remoteId: "t1",
					senderName: "Bob",
					senderAddress: "@bob",
					body: "Hi there",
					snippet: "Hi there",
					timestamp: 1000,
					isRead: false,
					isUrgent: false,
					hasAttachments: false,
				},
				{
					id: "b2",
					accountId: "acc_tg",
					remoteId: "t2",
					senderName: "Carol",
					senderAddress: "@carol",
					body: "Urgent meeting in 5 minutes",
					snippet: "Urgent meeting...",
					timestamp: 2000,
					isRead: false,
					isUrgent: true,
					hasAttachments: false,
				},
			];

			saveMessages(msgs, db);
			expect(getMessage("b1", db)?.senderName).toBe("Bob");
			expect(getMessage("b2", db)?.senderName).toBe("Carol");

			const result = getMessages({ accountId: "acc_tg" }, db);
			expect(result.total).toBe(2);
			expect(result.messages.length).toBe(2);
		});

		test("filters by provider, isRead, isUrgent, and pagination", () => {
			const messages: HubMessage[] = [
				{
					id: "m_w1",
					accountId: "acc_work",
					remoteId: "rw1",
					senderName: "Boss",
					senderAddress: "boss@company.com",
					subject: "Urgent: Quarterly Review",
					body: "Please review the quarterly slides",
					snippet: "Please review...",
					timestamp: 5000,
					isRead: false,
					isUrgent: true,
					hasAttachments: false,
				},
				{
					id: "m_w2",
					accountId: "acc_work",
					remoteId: "rw2",
					senderName: "Newsletter",
					senderAddress: "news@company.com",
					subject: "Weekly Digest",
					body: "Here is your weekly update",
					snippet: "Weekly update...",
					timestamp: 4000,
					isRead: true,
					isUrgent: false,
					hasAttachments: false,
				},
				{
					id: "m_t1",
					accountId: "acc_tg",
					remoteId: "rt1",
					senderName: "Friend",
					senderAddress: "@friend",
					body: "Coffee tomorrow?",
					snippet: "Coffee tomorrow?",
					timestamp: 3000,
					isRead: false,
					isUrgent: false,
					hasAttachments: false,
				},
			];
			saveMessages(messages, db);

			// Filter by provider
			const workOnly = getMessages({ provider: "email_work" }, db);
			expect(workOnly.total).toBe(2);
			expect(workOnly.messages.every((m) => m.accountId === "acc_work")).toBe(true);

			// Filter by isRead: false
			const unread = getMessages({ isRead: false }, db);
			expect(unread.total).toBe(2);

			// Filter by isUrgent: true
			const urgent = getMessages({ isUrgent: true }, db);
			expect(urgent.total).toBe(1);
			expect(urgent.messages[0]?.id).toBe("m_w1");

			// Pagination
			const paged = getMessages({ limit: 1, offset: 1 }, db);
			expect(paged.total).toBe(3);
			expect(paged.messages.length).toBe(1);
			expect(paged.messages[0]?.id).toBe("m_w2");
			expect(paged.hasMore).toBe(true);
		});
	});

	describe("Full-Text Search (FTS5)", () => {
		beforeEach(() => {
			saveAccount(
				{
					id: "acc_mail",
					provider: "email_personal",
					name: "Personal Mail",
					status: "connected",
					unreadCount: 0,
					lastSyncAt: null,
				},
				db,
			);

			const msgs: HubMessage[] = [
				{
					id: "fts1",
					accountId: "acc_mail",
					remoteId: "f1",
					senderName: "Airline Flight Support",
					senderAddress: "booking@airline.com",
					subject: "Your flight confirmation itinerary",
					body: "Confirmation code JFK123 for your upcoming trip to London",
					snippet: "Confirmation code JFK123...",
					timestamp: 1000,
					isRead: false,
					isUrgent: false,
					hasAttachments: false,
				},
				{
					id: "fts2",
					accountId: "acc_mail",
					remoteId: "f2",
					senderName: "Landlord Property Management",
					senderAddress: "office@apartments.com",
					subject: "Monthly lease invoice and maintenance",
					body: "Rent payment receipt for apartment 4B. Water heater inspection scheduled.",
					snippet: "Rent payment receipt...",
					timestamp: 2000,
					isRead: false,
					isUrgent: false,
					hasAttachments: false,
				},
			];
			saveMessages(msgs, db);
		});

		test("matches messages by body text, subject, and sender", () => {
			// Query body
			const q1 = getMessages({ query: "London" }, db);
			expect(q1.total).toBe(1);
			expect(q1.messages[0]?.id).toBe("fts1");

			// Query subject
			const q2 = getMessages({ query: "lease invoice" }, db);
			expect(q2.total).toBe(1);
			expect(q2.messages[0]?.id).toBe("fts2");

			// Query sender
			const q3 = getMessages({ query: "Property Management" }, db);
			expect(q3.total).toBe(1);
			expect(q3.messages[0]?.id).toBe("fts2");

			// Prefix query
			const q4 = getMessages({ query: "confirm" }, db);
			expect(q4.total).toBe(1);
			expect(q4.messages[0]?.id).toBe("fts1");
		});

		test("safely handles special punctuation and syntax characters", () => {
			expect(() => getMessages({ query: 'flight? !* () "quote"' }, db)).not.toThrow();
			const res = getMessages({ query: "flight? !*" }, db);
			expect(res.total).toBe(1);
			expect(res.messages[0]?.id).toBe("fts1");
		});

		test("updates FTS index on message update and deletion", () => {
			saveMessage(
				{
					id: "fts1",
					accountId: "acc_mail",
					remoteId: "f1",
					senderName: "Airline Flight Support",
					senderAddress: "booking@airline.com",
					subject: "Your flight was rescheduled to Tokyo",
					body: "Updated destination Tokyo flight code TYO999",
					snippet: "Updated destination Tokyo...",
					timestamp: 3000,
					isRead: false,
					isUrgent: false,
					hasAttachments: false,
				},
				db,
			);

			// London should no longer match
			expect(getMessages({ query: "London" }, db).total).toBe(0);
			// Tokyo should match
			expect(getMessages({ query: "Tokyo" }, db).total).toBe(1);

			// Delete message and check index cleanup
			deleteMessage("fts1", db);
			expect(getMessages({ query: "Tokyo" }, db).total).toBe(0);
		});
	});

	describe("markMessagesRead & Accurate modifiedCount", () => {
		beforeEach(() => {
			saveAccount(
				{
					id: "acc_tg",
					provider: "telegram",
					name: "Telegram",
					status: "connected",
					unreadCount: 0,
					lastSyncAt: null,
				},
				db,
			);

			const msgs: HubMessage[] = [
				{
					id: "m1",
					accountId: "acc_tg",
					remoteId: "r1",
					senderName: "Alice",
					senderAddress: "alice@test",
					body: "Message 1",
					snippet: "Message 1",
					timestamp: 100,
					isRead: false,
					isUrgent: false,
					hasAttachments: false,
				},
				{
					id: "m2",
					accountId: "acc_tg",
					remoteId: "r2",
					senderName: "Bob",
					senderAddress: "bob@test",
					body: "Message 2",
					snippet: "Message 2",
					timestamp: 200,
					isRead: false,
					isUrgent: false,
					hasAttachments: false,
				},
				{
					id: "m3",
					accountId: "acc_tg",
					remoteId: "r3",
					senderName: "Charlie",
					senderAddress: "charlie@test",
					body: "Message 3",
					snippet: "Message 3",
					timestamp: 300,
					isRead: false,
					isUrgent: false,
					hasAttachments: false,
				},
				{
					id: "m4",
					accountId: "acc_tg",
					remoteId: "r4",
					senderName: "Dave",
					senderAddress: "dave@test",
					body: "Message 4",
					snippet: "Message 4",
					timestamp: 400,
					isRead: true, // Already read!
					isUrgent: false,
					hasAttachments: false,
				},
			];
			saveMessages(msgs, db);
			recalculateUnreadCounts(db);
		});

		test("returns exact modified count matching unread rows without trigger inflation", () => {
			// Account unread count should be 3 initially
			expect(getAccount("acc_tg", db)?.unreadCount).toBe(3);

			// Mark specific message IDs (m1 is unread, m4 is already read)
			const count1 = markMessagesRead({ messageIds: ["m1", "m4"] }, db);
			expect(count1).toBe(1); // Only m1 changed!
			expect(getAccount("acc_tg", db)?.unreadCount).toBe(2);

			// Mark remaining messages by accountId
			const count2 = markMessagesRead({ accountId: "acc_tg" }, db);
			expect(count2).toBe(2); // m2 and m3 changed
			expect(getAccount("acc_tg", db)?.unreadCount).toBe(0);

			// Calling again should return 0 modified rows
			const count3 = markMessagesRead({ accountId: "acc_tg" }, db);
			expect(count3).toBe(0);
		});

		test("marks all messages read across accounts when params.all = true", () => {
			saveAccount(
				{
					id: "acc_other",
					provider: "email_work",
					name: "Other",
					status: "connected",
					unreadCount: 0,
					lastSyncAt: null,
				},
				db,
			);
			saveMessage(
				{
					id: "other_1",
					accountId: "acc_other",
					remoteId: "o1",
					senderName: "Colleague",
					senderAddress: "colleague@test",
					body: "Work notice",
					snippet: "Work notice",
					timestamp: 500,
					isRead: false,
					isUrgent: false,
					hasAttachments: false,
				},
				db,
			);
			recalculateUnreadCounts(db);

			// Currently unread: m1, m2, m3 (acc_tg) + other_1 (acc_other) = 4
			const totalMarked = markMessagesRead({ all: true }, db);
			expect(totalMarked).toBe(4);
			expect(getAccount("acc_tg", db)?.unreadCount).toBe(0);
			expect(getAccount("acc_other", db)?.unreadCount).toBe(0);
		});
	});

	describe("Agent Tasks CRUD", () => {
		test("saves, retrieves, updates status and deletes tasks", () => {
			const task: HubAgentTask = {
				id: "task_1",
				title: "Respond to flight change notice",
				description: "Flight was rescheduled to Tokyo",
				status: "pending",
				sourceMessageId: "fts1",
				suggestedAction: "Draft reply confirming Tokyo ticket",
				createdAt: 1000,
			};

			saveAgentTask(task, db);
			const fetched = getAgentTask("task_1", db);
			expect(fetched?.title).toBe("Respond to flight change notice");
			expect(fetched?.status).toBe("pending");

			updateAgentTaskStatus("task_1", "completed", db);
			const updated = getAgentTask("task_1", db);
			expect(updated?.status).toBe("completed");
			expect(updated?.completedAt).toBeDefined();

			const active = getAgentTasks("pending", db);
			expect(active.length).toBe(0);

			const completed = getAgentTasks("completed", db);
			expect(completed.length).toBe(1);

			expect(deleteAgentTask("task_1", db)).toBe(true);
			expect(getAgentTask("task_1", db)).toBeNull();
		});
	});

	describe("Dashboard Summary Aggregation", () => {
		test("aggregates total unread counts, urgent messages, recent activity, and tasks", () => {
			saveAccount(
				{
					id: "acc_summary",
					provider: "email_work",
					name: "Work Mail",
					status: "connected",
					unreadCount: 0,
					lastSyncAt: null,
				},
				db,
			);

			saveMessage(
				{
					id: "sum_urgent",
					accountId: "acc_summary",
					remoteId: "su1",
					senderName: "CTO",
					senderAddress: "cto@company.com",
					subject: "Urgent Server Outage",
					body: "Primary database CPU at 100%",
					snippet: "Primary database...",
					timestamp: 10000,
					isRead: false,
					isUrgent: true,
					hasAttachments: false,
				},
				db,
			);

			saveMessage(
				{
					id: "sum_normal",
					accountId: "acc_summary",
					remoteId: "su2",
					senderName: "Dev",
					senderAddress: "dev@company.com",
					subject: "PR ready for review",
					body: "Added new tests",
					snippet: "Added new...",
					timestamp: 9000,
					isRead: false,
					isUrgent: false,
					hasAttachments: false,
				},
				db,
			);

			recalculateUnreadCounts(db);

			const summary = getDashboardSummary(db);
			expect(summary.totalUnread).toBe(2);
			expect(summary.urgentMessages.length).toBe(1);
			expect(summary.urgentMessages[0]?.id).toBe("sum_urgent");
			expect(summary.recentActivity.length).toBe(2);
			expect(summary.accounts.find((a) => a.id === "acc_summary")?.unreadCount).toBe(2);
			expect(summary.suggestedAgentTasks.length).toBeGreaterThanOrEqual(1);
		});
	});
});
