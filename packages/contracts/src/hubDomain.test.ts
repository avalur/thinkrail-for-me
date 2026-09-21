import { describe, expect, test } from "bun:test";
import {
	HUB_ACCOUNT_PROVIDERS,
	HUB_ACCOUNT_STATUSES,
	HUB_AGENT_TASK_STATUSES,
	HUB_CHANNEL_KINDS,
	type HubAccount,
	type HubAgentTask,
	type HubChannel,
	type HubDashboardSummary,
	type HubMessage,
	isHubAccount,
	isHubAccountProvider,
	isHubAccountStatus,
	isHubAgentTask,
	isHubAgentTaskStatus,
	isHubChannel,
	isHubChannelKind,
	isHubDashboardSummary,
	isHubMessage,
} from "./hubDomain";

describe("Hub domain contracts", () => {
	test("account providers contain all 6 MVP and expansion services", () => {
		expect(HUB_ACCOUNT_PROVIDERS).toEqual([
			"telegram",
			"email_work",
			"email_personal",
			"slack",
			"discord",
			"whatsapp",
		]);

		for (const provider of HUB_ACCOUNT_PROVIDERS) {
			expect(isHubAccountProvider(provider)).toBe(true);
		}
		expect(isHubAccountProvider("unknown_service")).toBe(false);
		expect(isHubAccountProvider(123)).toBe(false);
		expect(isHubAccountProvider(null)).toBe(false);
	});

	test("account statuses are bounded and validated", () => {
		expect(HUB_ACCOUNT_STATUSES).toEqual([
			"connected",
			"connecting",
			"disconnected",
			"error",
			"syncing",
		]);

		for (const status of HUB_ACCOUNT_STATUSES) {
			expect(isHubAccountStatus(status)).toBe(true);
		}
		expect(isHubAccountStatus("offline")).toBe(false);
		expect(isHubAccountStatus(undefined)).toBe(false);
	});

	test("channel kinds are bounded and validated", () => {
		expect(HUB_CHANNEL_KINDS).toEqual(["dm", "channel", "group", "folder", "thread"]);

		for (const kind of HUB_CHANNEL_KINDS) {
			expect(isHubChannelKind(kind)).toBe(true);
		}
		expect(isHubChannelKind("invalid")).toBe(false);
		expect(isHubChannelKind(null)).toBe(false);
	});

	test("agent task statuses are bounded and validated", () => {
		expect(HUB_AGENT_TASK_STATUSES).toEqual([
			"pending",
			"running",
			"completed",
			"failed",
			"cancelled",
		]);

		for (const status of HUB_AGENT_TASK_STATUSES) {
			expect(isHubAgentTaskStatus(status)).toBe(true);
		}
		expect(isHubAgentTaskStatus("done")).toBe(false);
		expect(isHubAgentTaskStatus(null)).toBe(false);
	});

	test("isHubAccount validates account entities", () => {
		const validAccount: HubAccount = {
			id: "acc_1",
			provider: "email_work",
			name: "Work Email",
			email: "dev@company.com",
			status: "connected",
			unreadCount: 5,
			lastSyncAt: 1726915200000,
		};
		expect(isHubAccount(validAccount)).toBe(true);

		expect(isHubAccount({ ...validAccount, lastSyncAt: null })).toBe(true);
		expect(isHubAccount({ ...validAccount, provider: "invalid" })).toBe(false);
		expect(isHubAccount({ ...validAccount, status: "unknown" })).toBe(false);
		expect(isHubAccount({ ...validAccount, unreadCount: "5" })).toBe(false);
		expect(isHubAccount(null)).toBe(false);
		expect(isHubAccount("not an object")).toBe(false);
	});

	test("isHubChannel validates channel entities", () => {
		const validChannel: HubChannel = {
			id: "ch_1",
			accountId: "acc_1",
			remoteId: "inbox",
			name: "Inbox",
			kind: "folder",
			unreadCount: 3,
			lastMessageAt: 1726915200000,
		};
		expect(isHubChannel(validChannel)).toBe(true);

		expect(isHubChannel({ ...validChannel, kind: undefined })).toBe(true);
		expect(
			isHubChannel({ ...validChannel, kind: "nonexistent" as unknown as HubChannel["kind"] }),
		).toBe(false);
		expect(isHubChannel({ ...validChannel, id: 123 as unknown as string })).toBe(false);
		expect(isHubChannel(null)).toBe(false);
	});

	test("isHubMessage validates message entities", () => {
		const validMessage: HubMessage = {
			id: "msg_1",
			accountId: "acc_1",
			remoteId: "remote_101",
			channelId: "ch_1",
			senderName: "Alice Smith",
			senderAddress: "alice@example.com",
			recipientAddress: "dev@company.com",
			subject: "Sprint Sync Followup",
			body: "Here is the summary of today's standup notes and action items.",
			snippet: "Here is the summary of today's standup notes...",
			timestamp: 1726915200000,
			isRead: false,
			isUrgent: true,
			hasAttachments: false,
		};
		expect(isHubMessage(validMessage)).toBe(true);

		expect(isHubMessage({ ...validMessage, isRead: "false" as unknown as boolean })).toBe(false);
		expect(isHubMessage({ ...validMessage, timestamp: "now" as unknown as number })).toBe(false);
		expect(isHubMessage({ ...validMessage, body: undefined as unknown as string })).toBe(false);
		expect(isHubMessage(null)).toBe(false);
	});

	test("isHubAgentTask validates background task entities", () => {
		const validTask: HubAgentTask = {
			id: "task_1",
			title: "Draft reply to Alice's email",
			description: "Prepare an update regarding the PR review status.",
			status: "pending",
			sourceMessageId: "msg_1",
			sourceAccountId: "acc_1",
			suggestedAction: "hub_send_email",
			createdAt: 1726915200000,
		};
		expect(isHubAgentTask(validTask)).toBe(true);

		expect(
			isHubAgentTask({ ...validTask, status: "unknown" as unknown as HubAgentTask["status"] }),
		).toBe(false);
		expect(isHubAgentTask({ ...validTask, createdAt: "2026-09-21" as unknown as number })).toBe(
			false,
		);
		expect(isHubAgentTask(null)).toBe(false);
	});

	test("isHubDashboardSummary validates dashboard aggregation", () => {
		const summary: HubDashboardSummary = {
			totalUnread: 7,
			accounts: [
				{
					id: "acc_1",
					provider: "email_work",
					name: "Work Email",
					email: "dev@company.com",
					status: "connected",
					unreadCount: 5,
					lastSyncAt: 1726915200000,
				},
				{
					id: "acc_2",
					provider: "telegram",
					name: "Telegram",
					status: "connected",
					unreadCount: 2,
					lastSyncAt: 1726915200000,
				},
			],
			urgentMessages: [
				{
					id: "msg_1",
					accountId: "acc_1",
					remoteId: "remote_101",
					senderName: "Alice Smith",
					senderAddress: "alice@example.com",
					subject: "Urgent: Build failure on staging",
					body: "The pipeline failed on staging.",
					snippet: "The pipeline failed on staging.",
					timestamp: 1726915200000,
					isRead: false,
					isUrgent: true,
					hasAttachments: false,
				},
			],
			recentActivity: [],
			suggestedAgentTasks: ["Triage 5 unread work emails", "Draft reply to Alice"],
		};
		expect(isHubDashboardSummary(summary)).toBe(true);

		expect(isHubDashboardSummary({ ...summary, totalUnread: "7" as unknown as number })).toBe(
			false,
		);
		expect(
			isHubDashboardSummary({
				...summary,
				accounts: null as unknown as HubDashboardSummary["accounts"],
			}),
		).toBe(false);
		expect(isHubDashboardSummary(null)).toBe(false);
	});
});
