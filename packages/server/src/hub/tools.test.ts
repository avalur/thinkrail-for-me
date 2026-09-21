import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HubAccount, HubMessage } from "@thinkrail/contracts";
import type { Static, TSchema } from "typebox";
import { getAgentTasks, initHubDb, saveAccount, saveMessage, setHubDbForTesting } from "./db";
import {
	createHubListUnreadTool,
	createHubSearchMessagesTool,
	createHubSendDiscordTool,
	createHubSendEmailTool,
	createHubSendSlackTool,
	createHubSendTelegramTool,
	createHubSendWhatsAppTool,
	createHubSummarizeInboxTool,
	hubToolsExtension,
} from "./tools";

async function executeTool<TParams extends TSchema, TDetails>(
	tool: ToolDefinition<TParams, TDetails>,
	toolCallId: string,
	params: Static<TParams>,
) {
	return tool.execute(toolCallId, params, undefined, undefined, {} as never);
}

function getResultText(result: { content: Array<{ type: string; text?: string }> }): string {
	const item = result.content[0];
	if (item && item.type === "text" && typeof item.text === "string") {
		return item.text;
	}
	return "";
}

describe("Personal Hub Agent Tools", () => {
	let testDb: Database;

	beforeEach(() => {
		testDb = new Database(":memory:");
		initHubDb(testDb);
		setHubDbForTesting(testDb);
	});

	afterEach(() => {
		setHubDbForTesting(null);
		testDb.close();
	});

	function seedTestAccounts(): {
		workEmail: HubAccount;
		personalEmail: HubAccount;
		telegram: HubAccount;
		slack: HubAccount;
		discord: HubAccount;
		whatsapp: HubAccount;
	} {
		const workEmail: HubAccount = {
			id: "acc_work_email",
			provider: "email_work",
			name: "Work Email",
			email: "dev@company.com",
			status: "connected",
			unreadCount: 0,
			lastSyncAt: Date.now(),
		};
		const personalEmail: HubAccount = {
			id: "acc_personal_email",
			provider: "email_personal",
			name: "Personal Gmail",
			email: "me@gmail.com",
			status: "connected",
			unreadCount: 0,
			lastSyncAt: Date.now(),
		};
		const telegram: HubAccount = {
			id: "acc_telegram",
			provider: "telegram",
			name: "Telegram Bot",
			status: "connected",
			unreadCount: 0,
			lastSyncAt: Date.now(),
		};
		const slack: HubAccount = {
			id: "acc_slack",
			provider: "slack",
			name: "Workspace Slack",
			status: "connected",
			unreadCount: 0,
			lastSyncAt: Date.now(),
		};
		const discord: HubAccount = {
			id: "acc_discord",
			provider: "discord",
			name: "Server Discord",
			status: "connected",
			unreadCount: 0,
			lastSyncAt: Date.now(),
		};
		const whatsapp: HubAccount = {
			id: "acc_whatsapp",
			provider: "whatsapp",
			name: "WhatsApp Account",
			status: "connected",
			unreadCount: 0,
			lastSyncAt: Date.now(),
		};

		saveAccount(workEmail);
		saveAccount(personalEmail);
		saveAccount(telegram);
		saveAccount(slack);
		saveAccount(discord);
		saveAccount(whatsapp);

		return { workEmail, personalEmail, telegram, slack, discord, whatsapp };
	}

	describe("hub_list_unread", () => {
		it("returns empty response message when there are no unread messages", async () => {
			seedTestAccounts();
			const tool = createHubListUnreadTool();
			const result = await executeTool(tool, "call_1", {});

			expect(result.content[0]?.type).toBe("text");
			expect(getResultText(result)).toContain("No unread messages found");
			expect((result.details as { total: number }).total).toBe(0);
		});

		it("lists unread messages and supports priorityOnly filter", async () => {
			const { workEmail, telegram } = seedTestAccounts();

			const normalMsg: HubMessage = {
				id: "msg_normal",
				accountId: workEmail.id,
				remoteId: "rem_1",
				senderName: "Alice",
				senderAddress: "alice@company.com",
				subject: "Weekly Newsletter",
				body: "Here is the weekly update.",
				snippet: "Here is the weekly update.",
				timestamp: Date.now() - 1000,
				isRead: false,
				isUrgent: false,
				hasAttachments: false,
			};

			const urgentMsg: HubMessage = {
				id: "msg_urgent",
				accountId: telegram.id,
				remoteId: "rem_2",
				senderName: "Bob",
				senderAddress: "@bob",
				body: "URGENT: Production database high CPU alert!",
				snippet: "URGENT: Production database high CPU alert!",
				timestamp: Date.now(),
				isRead: false,
				isUrgent: true,
				hasAttachments: false,
			};

			saveMessage(normalMsg);
			saveMessage(urgentMsg);

			const tool = createHubListUnreadTool();

			// All unread
			const allResult = await executeTool(tool, "call_all", {});
			const allText = getResultText(allResult);
			expect(allText).toContain("Weekly Newsletter");
			expect(allText).toContain("Production database");
			expect((allResult.details as { count: number }).count).toBe(2);

			// Urgent only
			const urgentResult = await executeTool(tool, "call_urgent", { priorityOnly: true });
			const urgentText = getResultText(urgentResult);
			expect(urgentText).toContain("Production database");
			expect(urgentText).not.toContain("Weekly Newsletter");
			expect((urgentResult.details as { count: number }).count).toBe(1);
		});
	});

	describe("hub_search_messages", () => {
		it("searches across message subjects and bodies using FTS5", async () => {
			const { workEmail } = seedTestAccounts();

			saveMessage({
				id: "msg_launch",
				accountId: workEmail.id,
				remoteId: "rem_launch",
				senderName: "Charlie",
				senderAddress: "charlie@company.com",
				subject: "ThinkRail v1 Launch Roadmap",
				body: "We are preparing the final deliverables for release next Tuesday.",
				snippet: "We are preparing the final deliverables...",
				timestamp: Date.now(),
				isRead: true,
				isUrgent: false,
				hasAttachments: false,
			});

			const tool = createHubSearchMessagesTool();

			// Matching query
			const matchResult = await executeTool(tool, "call_search_1", { query: "Launch" });
			expect(getResultText(matchResult)).toContain("ThinkRail v1 Launch Roadmap");
			expect((matchResult.details as { total: number }).total).toBe(1);

			// Non-matching query
			const missResult = await executeTool(tool, "call_search_2", { query: "UnrelatedQuery" });
			expect(getResultText(missResult)).toContain('No messages found matching "UnrelatedQuery"');
			expect((missResult.details as { total: number }).total).toBe(0);
		});
	});

	describe("hub_send_email", () => {
		it("returns error when no email accounts are configured", async () => {
			const tool = createHubSendEmailTool();
			const result = await executeTool(tool, "call_email_1", {
				recipient: "colleague@example.com",
				subject: "Meeting",
				body: "Can we sync at 3pm?",
			});

			expect(getResultText(result)).toContain("Error: No configured email account found");
			expect((result.details as { success: boolean }).success).toBe(false);
		});

		it("auto-selects available email account and sends email", async () => {
			const { workEmail } = seedTestAccounts();
			const tool = createHubSendEmailTool();

			const result = await executeTool(tool, "call_email_2", {
				recipient: "client@example.com",
				subject: "Project Update",
				body: "The sprint deliverables are ready.",
			});

			expect(getResultText(result)).toContain("Email sent successfully to client@example.com");
			expect((result.details as { success: boolean }).success).toBe(true);

			const messageId = (result.details as { messageId: string }).messageId;
			expect(messageId).toBeDefined();

			// Verify outbound message was persisted in SQLite
			const dbMessages = testDb
				.query("SELECT * FROM hub_messages WHERE id = ?")
				.all(messageId) as Array<{
				id: string;
				account_id: string;
				recipient_address: string;
				subject: string;
			}>;
			expect(dbMessages.length).toBe(1);
			const firstMsg = dbMessages[0];
			expect(firstMsg).toBeDefined();
			if (firstMsg) {
				expect(firstMsg.account_id).toBe(workEmail.id);
				expect(firstMsg.recipient_address).toBe("client@example.com");
				expect(firstMsg.subject).toBe("Project Update");
			}
		});
	});

	describe("hub_send_telegram", () => {
		it("returns error when no Telegram accounts are configured", async () => {
			const tool = createHubSendTelegramTool();
			const result = await executeTool(tool, "call_tg_1", {
				chatId: "123456",
				text: "Hello from agent",
			});

			expect(getResultText(result)).toContain("Error: No configured Telegram account found");
			expect((result.details as { success: boolean }).success).toBe(false);
		});

		it("sends Telegram message using configured account", async () => {
			const { telegram } = seedTestAccounts();
			const tool = createHubSendTelegramTool();

			const result = await executeTool(tool, "call_tg_2", {
				chatId: "987654321",
				text: "Server deployment completed successfully.",
			});

			expect(getResultText(result)).toContain(
				"Telegram message sent successfully to chat 987654321",
			);
			expect((result.details as { success: boolean }).success).toBe(true);

			const messageId = (result.details as { messageId: string }).messageId;
			expect(messageId).toBeDefined();

			// Verify outbound message persisted
			const dbMessages = testDb
				.query("SELECT * FROM hub_messages WHERE id = ?")
				.all(messageId) as Array<{
				id: string;
				account_id: string;
				recipient_address: string;
				body: string;
			}>;
			expect(dbMessages.length).toBe(1);
			const firstMsg = dbMessages[0];
			expect(firstMsg).toBeDefined();
			if (firstMsg) {
				expect(firstMsg.account_id).toBe(telegram.id);
				expect(firstMsg.recipient_address).toBe("987654321");
				expect(firstMsg.body).toBe("Server deployment completed successfully.");
			}
		});
	});

	describe("hub_send_slack", () => {
		it("sends Slack message using configured account and saves to DB", async () => {
			const { slack } = seedTestAccounts();
			const tool = createHubSendSlackTool();

			const result = await executeTool(tool, "call_slack_1", {
				channel: "#engineering",
				text: "Feature branch merged and ready for QA testing.",
				threadTs: "1710000500.000100",
			});

			expect(getResultText(result)).toContain("Slack message sent successfully to #engineering");
			expect((result.details as { success: boolean }).success).toBe(true);

			const messageId = (result.details as { messageId: string }).messageId;
			expect(messageId).toBeDefined();

			const saved = testDb.query("SELECT * FROM hub_messages WHERE id = ?").get(messageId) as {
				account_id: string;
				recipient_address: string;
				body: string;
			} | null;
			expect(saved).toBeDefined();
			expect(saved?.account_id).toBe(slack.id);
			expect(saved?.recipient_address).toBe("#engineering");
			expect(saved?.body).toBe("Feature branch merged and ready for QA testing.");
		});
	});

	describe("hub_send_discord", () => {
		it("sends Discord message using configured account and saves to DB", async () => {
			const { discord } = seedTestAccounts();
			const tool = createHubSendDiscordTool();

			const result = await executeTool(tool, "call_discord_1", {
				channelId: "1234567890",
				content: "Community call starts in 15 minutes!",
			});

			expect(getResultText(result)).toContain(
				"Discord message sent successfully to channel 1234567890",
			);
			expect((result.details as { success: boolean }).success).toBe(true);

			const messageId = (result.details as { messageId: string }).messageId;
			expect(messageId).toBeDefined();

			const saved = testDb.query("SELECT * FROM hub_messages WHERE id = ?").get(messageId) as {
				account_id: string;
				recipient_address: string;
				body: string;
			} | null;
			expect(saved).toBeDefined();
			expect(saved?.account_id).toBe(discord.id);
			expect(saved?.recipient_address).toBe("1234567890");
			expect(saved?.body).toBe("Community call starts in 15 minutes!");
		});
	});

	describe("hub_send_whatsapp", () => {
		it("sends WhatsApp message using configured account and saves to DB", async () => {
			const { whatsapp } = seedTestAccounts();
			const tool = createHubSendWhatsAppTool();

			const result = await executeTool(tool, "call_wa_1", {
				recipient: "+15551234567",
				text: "Your order #1082 has been shipped.",
			});

			expect(getResultText(result)).toContain("WhatsApp message sent successfully to +15551234567");
			expect((result.details as { success: boolean }).success).toBe(true);

			const messageId = (result.details as { messageId: string }).messageId;
			expect(messageId).toBeDefined();

			const saved = testDb.query("SELECT * FROM hub_messages WHERE id = ?").get(messageId) as {
				account_id: string;
				recipient_address: string;
				body: string;
			} | null;
			expect(saved).toBeDefined();
			expect(saved?.account_id).toBe(whatsapp.id);
			expect(saved?.recipient_address).toBe("+15551234567");
			expect(saved?.body).toBe("Your order #1082 has been shipped.");
		});
	});

	describe("hub_summarize_inbox", () => {
		it("generates structured executive briefing and extracts actionable tasks", async () => {
			const { workEmail, telegram } = seedTestAccounts();

			// Urgent message with action keywords
			const urgentMsg: HubMessage = {
				id: "msg_urgent_action",
				accountId: workEmail.id,
				remoteId: "rem_urgent_action",
				senderName: "Sarah Director",
				senderAddress: "sarah@company.com",
				subject: "Urgent: Q3 Budget Approval Required",
				body: "Please review and approve the attached Q3 budget spreadsheet ASAP before 5 PM deadline.",
				snippet: "Please review and approve the attached Q3 budget...",
				timestamp: Date.now() - 3600 * 1000,
				isRead: false,
				isUrgent: true,
				hasAttachments: true,
			};

			// Regular unread chat
			const chatMsg: HubMessage = {
				id: "msg_chat",
				accountId: telegram.id,
				remoteId: "rem_chat",
				senderName: "Developer Group",
				senderAddress: "@devgroup",
				body: "Hey team, standup starts in 10 minutes.",
				snippet: "Hey team, standup starts in 10 minutes.",
				timestamp: Date.now() - 1800 * 1000,
				isRead: false,
				isUrgent: false,
				hasAttachments: false,
			};

			saveMessage(urgentMsg);
			saveMessage(chatMsg);

			const tool = createHubSummarizeInboxTool();

			const result = await executeTool(tool, "call_summary", {
				hours: 24,
				extractTasks: true,
			});

			const text = getResultText(result);
			expect(text).toContain("# 📬 Personal Hub Executive Digest");
			expect(text).toContain("Urgent Attention Required");
			expect(text).toContain("Sarah Director");
			expect(text).toContain("Q3 Budget Approval");
			expect(text).toContain("Channel & Account Activity");
			expect(text).toContain("Newly Extracted Action Items");

			// Verify task was saved in SQLite
			const tasks = getAgentTasks();
			expect(tasks.length).toBe(1);
			const firstTask = tasks[0];
			expect(firstTask).toBeDefined();
			if (firstTask) {
				expect(firstTask.sourceMessageId).toBe(urgentMsg.id);
				expect(firstTask.title).toContain("Q3 Budget Approval");
				expect(firstTask.status).toBe("pending");
			}
		});
	});

	describe("hubToolsExtension", () => {
		it("registers all 8 hub tools with ExtensionAPI", () => {
			const registeredTools: Array<ToolDefinition<TSchema, unknown>> = [];
			const mockPi = {
				registerTool(tool: ToolDefinition<TSchema, unknown>) {
					registeredTools.push(tool);
				},
			} as unknown as ExtensionAPI;

			hubToolsExtension(mockPi);

			const names = registeredTools.map((t) => t.name);
			expect(names).toContain("hub_list_unread");
			expect(names).toContain("hub_search_messages");
			expect(names).toContain("hub_send_email");
			expect(names).toContain("hub_send_telegram");
			expect(names).toContain("hub_send_slack");
			expect(names).toContain("hub_send_discord");
			expect(names).toContain("hub_send_whatsapp");
			expect(names).toContain("hub_summarize_inbox");
			expect(registeredTools.length).toBe(8);
		});
	});

	describe("Personal Hub Skill", () => {
		it("skill file exists and contains valid frontmatter metadata", () => {
			const skillPath = join(import.meta.dir, "skill", "SKILL.md");
			expect(existsSync(skillPath)).toBe(true);

			const content = readFileSync(skillPath, "utf8");
			expect(content).toContain("name: personal-hub");
			expect(content).toContain("description:");
			expect(content).toContain("hub_list_unread");
			expect(content).toContain("hub_summarize_inbox");
			expect(content).toContain("hub_send_slack");
			expect(content).toContain("hub_send_discord");
			expect(content).toContain("hub_send_whatsapp");
			expect(content).toContain("Daily Executive Briefing");
		});
	});
});
