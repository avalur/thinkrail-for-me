import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { HubAgentTask, HubMessage } from "@thinkrail/contracts";
import { type Static, Type } from "typebox";
import { getAccounts, getAgentTasks, getDashboardSummary, getMessages, saveAgentTask } from "./db";
import { sendHubMessage } from "./handlers";

// --- Schema Definitions ---

export const HubAccountProviderSchema = Type.Union(
	[
		Type.Literal("telegram"),
		Type.Literal("email_work"),
		Type.Literal("email_personal"),
		Type.Literal("slack"),
		Type.Literal("discord"),
		Type.Literal("whatsapp"),
	],
	{ description: "Communication account provider." },
);

export const HUB_LIST_UNREAD_TOOL_NAME = "hub_list_unread";
export const HubListUnreadSchema = Type.Object({
	accountId: Type.Optional(
		Type.String({
			description:
				"Optional account ID to filter by (e.g. 'account_email_work', 'account_telegram').",
		}),
	),
	provider: Type.Optional(HubAccountProviderSchema),
	priorityOnly: Type.Optional(
		Type.Boolean({
			description:
				"If true, only returns urgent or high-priority unread messages (default: false).",
		}),
	),
	limit: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 100,
			description: "Maximum number of unread messages to return (default: 20).",
		}),
	),
	offset: Type.Optional(
		Type.Integer({
			minimum: 0,
			description: "Pagination offset (default: 0).",
		}),
	),
});
export type HubListUnreadParams = Static<typeof HubListUnreadSchema>;

export const HUB_SEARCH_MESSAGES_TOOL_NAME = "hub_search_messages";
export const HubSearchMessagesSchema = Type.Object({
	query: Type.String({
		description:
			"Search query or keywords to match across message subjects, bodies, and sender info.",
	}),
	accountId: Type.Optional(
		Type.String({
			description: "Optional account ID to restrict the search to.",
		}),
	),
	provider: Type.Optional(HubAccountProviderSchema),
	limit: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 100,
			description: "Maximum number of messages to return (default: 20).",
		}),
	),
	offset: Type.Optional(
		Type.Integer({
			minimum: 0,
			description: "Pagination offset (default: 0).",
		}),
	),
});
export type HubSearchMessagesParams = Static<typeof HubSearchMessagesSchema>;

export const HUB_SEND_EMAIL_TOOL_NAME = "hub_send_email";
export const HubSendEmailSchema = Type.Object({
	recipient: Type.String({
		description: "Recipient email address (e.g. 'colleague@example.com').",
	}),
	subject: Type.String({
		description: "Subject line of the email.",
	}),
	body: Type.String({
		description: "Plain text content of the email.",
	}),
	accountId: Type.Optional(
		Type.String({
			description:
				"Optional email account ID to send from. Defaults to the first available connected email account.",
		}),
	),
	replyToMessageId: Type.Optional(
		Type.String({
			description: "Optional ID of the message being replied to.",
		}),
	),
});
export type HubSendEmailParams = Static<typeof HubSendEmailSchema>;

export const HUB_SEND_TELEGRAM_TOOL_NAME = "hub_send_telegram";
export const HubSendTelegramSchema = Type.Object({
	chatId: Type.String({
		description:
			"Target Telegram chat ID, username, or channel ID (e.g. '123456789' or '@channel').",
	}),
	text: Type.String({
		description: "Text message content to send via Telegram.",
	}),
	accountId: Type.Optional(
		Type.String({
			description:
				"Optional Telegram account ID to send from. Defaults to the first available Telegram account.",
		}),
	),
	replyToMessageId: Type.Optional(
		Type.String({
			description: "Optional message ID or remote message ID to reply to.",
		}),
	),
});
export type HubSendTelegramParams = Static<typeof HubSendTelegramSchema>;

export const HUB_SEND_SLACK_TOOL_NAME = "hub_send_slack";
export const HubSendSlackSchema = Type.Object({
	channel: Type.String({
		description: "Target Slack channel name or ID (e.g. '#general', 'general', or 'C12345678').",
	}),
	text: Type.String({
		description: "Text message content to send via Slack.",
	}),
	accountId: Type.Optional(
		Type.String({
			description:
				"Optional Slack account ID to send from. Defaults to the first available Slack account.",
		}),
	),
	threadTs: Type.Optional(
		Type.String({
			description: "Optional parent message timestamp (thread_ts) to reply in thread.",
		}),
	),
});
export type HubSendSlackParams = Static<typeof HubSendSlackSchema>;

export const HUB_SEND_DISCORD_TOOL_NAME = "hub_send_discord";
export const HubSendDiscordSchema = Type.Object({
	channelId: Type.String({
		description:
			"Target Discord channel ID or channel name (e.g. '123456789012345678' or '#announcements').",
	}),
	content: Type.String({
		description: "Text content to send via Discord.",
	}),
	accountId: Type.Optional(
		Type.String({
			description:
				"Optional Discord account ID to send from. Defaults to the first available Discord account.",
		}),
	),
	replyToMessageId: Type.Optional(
		Type.String({
			description: "Optional Discord message ID to reply to.",
		}),
	),
});
export type HubSendDiscordParams = Static<typeof HubSendDiscordSchema>;

export const HUB_SEND_WHATSAPP_TOOL_NAME = "hub_send_whatsapp";
export const HubSendWhatsAppSchema = Type.Object({
	recipient: Type.String({
		description:
			"Target WhatsApp phone number with country code (e.g. '+15551234567' or '15551234567') or group remote ID.",
	}),
	text: Type.String({
		description: "Text message content to send via WhatsApp.",
	}),
	accountId: Type.Optional(
		Type.String({
			description:
				"Optional WhatsApp account ID to send from. Defaults to the first available WhatsApp account.",
		}),
	),
	replyToMessageId: Type.Optional(
		Type.String({
			description: "Optional WhatsApp message ID to reply to.",
		}),
	),
});
export type HubSendWhatsAppParams = Static<typeof HubSendWhatsAppSchema>;

export const HUB_SUMMARIZE_INBOX_TOOL_NAME = "hub_summarize_inbox";
export const HubSummarizeInboxSchema = Type.Object({
	hours: Type.Optional(
		Type.Number({
			minimum: 1,
			maximum: 168,
			description: "Time window in hours to summarize (default: 24, max: 168 / 7 days).",
		}),
	),
	accountId: Type.Optional(
		Type.String({
			description: "Optional account ID to restrict summary to.",
		}),
	),
	provider: Type.Optional(HubAccountProviderSchema),
	includeRead: Type.Optional(
		Type.Boolean({
			description:
				"Whether to include already-read messages in the summary (default: false, unread only).",
		}),
	),
	limit: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 200,
			description: "Maximum number of messages to analyze (default: 50).",
		}),
	),
	extractTasks: Type.Optional(
		Type.Boolean({
			description:
				"If true, automatically creates pending hub agent tasks in SQLite for actionable items (default: false).",
		}),
	),
});
export type HubSummarizeInboxParams = Static<typeof HubSummarizeInboxSchema>;

// --- Helper Formatting ---

function formatMessageItem(msg: HubMessage): string {
	const urgencyTag = msg.isUrgent ? "🚨 **[URGENT]** " : "";
	const readTag = msg.isRead ? "" : "🔵 [UNREAD] ";
	const subjectPart = msg.subject ? `*${msg.subject}*: ` : "";
	const dateStr = new Date(msg.timestamp).toISOString();
	return `- [${msg.id}] ${urgencyTag}${readTag}**${msg.senderName}** (${msg.senderAddress}): ${subjectPart}${msg.snippet} *(Account: ${msg.accountId}, ${dateStr})*`;
}

// --- Tool Implementations ---

export function createHubListUnreadTool(): ToolDefinition<typeof HubListUnreadSchema> {
	return {
		name: HUB_LIST_UNREAD_TOOL_NAME,
		label: "List Unread Messages",
		description:
			"List unread messages across connected communications accounts (Email, Telegram, Slack, etc.). Supports filtering by specific account or provider, and filtering for priority/urgent items only.",
		parameters: HubListUnreadSchema,
		async execute(_toolCallId, params) {
			const { accountId, provider, priorityOnly, limit = 20, offset = 0 } = params;
			const filter = {
				isRead: false,
				...(priorityOnly ? { isUrgent: true } : {}),
				...(accountId ? { accountId } : {}),
				...(provider ? { provider } : {}),
				limit,
				offset,
			};

			const result = getMessages(filter);
			if (result.messages.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: priorityOnly
								? "No urgent unread messages found matching the filter."
								: "No unread messages found matching the filter.",
						},
					],
					details: {
						total: 0,
						count: 0,
						hasMore: false,
						priorityOnly: !!priorityOnly,
						messages: [],
					},
				};
			}

			const header = `### Unread Messages (${result.messages.length} of ${result.total}${priorityOnly ? ", urgent only" : ""})\n\n`;
			const body = result.messages.map(formatMessageItem).join("\n");
			const footer = result.hasMore
				? `\n\n*(More messages available, offset: ${offset + limit})*`
				: "";

			return {
				content: [{ type: "text", text: `${header}${body}${footer}` }],
				details: {
					total: result.total,
					count: result.messages.length,
					hasMore: result.hasMore,
					priorityOnly: !!priorityOnly,
					messages: result.messages,
				},
			};
		},
	};
}

export function createHubSearchMessagesTool(): ToolDefinition<typeof HubSearchMessagesSchema> {
	return {
		name: HUB_SEARCH_MESSAGES_TOOL_NAME,
		label: "Search Messages",
		description:
			"Search communication history using full-text search keywords across message bodies, subjects, and sender info with optional account/provider filters.",
		parameters: HubSearchMessagesSchema,
		async execute(_toolCallId, params) {
			const { query, accountId, provider, limit = 20, offset = 0 } = params;
			const filter = {
				query,
				...(accountId ? { accountId } : {}),
				...(provider ? { provider } : {}),
				limit,
				offset,
			};

			const result = getMessages(filter);
			if (result.messages.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No messages found matching "${query}".`,
						},
					],
					details: {
						query,
						total: 0,
						count: 0,
						hasMore: false,
						messages: [],
					},
				};
			}

			const header = `### Search Results for "${query}" (${result.messages.length} of ${result.total})\n\n`;
			const body = result.messages.map(formatMessageItem).join("\n");
			const footer = result.hasMore
				? `\n\n*(More messages available, offset: ${offset + limit})*`
				: "";

			return {
				content: [{ type: "text", text: `${header}${body}${footer}` }],
				details: {
					query,
					total: result.total,
					count: result.messages.length,
					hasMore: result.hasMore,
					messages: result.messages,
				},
			};
		},
	};
}

export function createHubSendEmailTool(): ToolDefinition<typeof HubSendEmailSchema> {
	return {
		name: HUB_SEND_EMAIL_TOOL_NAME,
		label: "Send Email",
		description:
			"Send an outbound email or reply via a configured email account (SMTP). If accountId is omitted, automatically selects the first available email account.",
		parameters: HubSendEmailSchema,
		async execute(_toolCallId, params) {
			const { recipient, subject, body, accountId, replyToMessageId } = params;

			let targetAccountId = accountId;
			let accountName = "";

			if (!targetAccountId) {
				const accounts = getAccounts();
				const emailAccount =
					accounts.find((a) => a.provider === "email_work") ??
					accounts.find((a) => a.provider === "email_personal");
				if (!emailAccount) {
					return {
						content: [
							{
								type: "text",
								text: "Error: No configured email account found. Please configure a work or personal email account in Personal Hub settings.",
							},
						],
						details: {
							success: false,
							error: "No configured email account found",
						},
					};
				}
				targetAccountId = emailAccount.id;
				accountName = emailAccount.name;
			} else {
				const accounts = getAccounts();
				const acc = accounts.find((a) => a.id === targetAccountId);
				accountName = acc ? acc.name : targetAccountId;
			}

			const sendResult = await sendHubMessage({
				accountId: targetAccountId,
				recipient,
				subject,
				body,
				...(replyToMessageId ? { replyToMessageId } : {}),
			});

			if (!sendResult.success) {
				return {
					content: [
						{
							type: "text",
							text: `Failed to send email to ${recipient}: ${sendResult.error ?? "Unknown delivery error"}`,
						},
					],
					details: {
						success: false,
						error: sendResult.error,
						recipient,
						subject,
					},
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `Email sent successfully to ${recipient} (Subject: "${subject}", Message ID: ${sendResult.messageId}, Account: ${accountName}).`,
					},
				],
				details: {
					success: true,
					messageId: sendResult.messageId,
					accountId: targetAccountId,
					recipient,
					subject,
				},
			};
		},
	};
}

export function createHubSendTelegramTool(): ToolDefinition<typeof HubSendTelegramSchema> {
	return {
		name: HUB_SEND_TELEGRAM_TOOL_NAME,
		label: "Send Telegram Message",
		description:
			"Send an outbound Telegram message or reply to a chat ID or channel using the configured Telegram account (Bot API).",
		parameters: HubSendTelegramSchema,
		async execute(_toolCallId, params) {
			const { chatId, text, accountId, replyToMessageId } = params;

			let targetAccountId = accountId;
			let accountName = "";

			if (!targetAccountId) {
				const accounts = getAccounts("telegram");
				const defaultAccount = accounts[0];
				if (!defaultAccount) {
					return {
						content: [
							{
								type: "text",
								text: "Error: No configured Telegram account found. Please configure a Telegram account in Personal Hub settings.",
							},
						],
						details: {
							success: false,
							error: "No configured Telegram account found",
						},
					};
				}
				targetAccountId = defaultAccount.id;
				accountName = defaultAccount.name;
			} else {
				const accounts = getAccounts("telegram");
				const acc = accounts.find((a) => a.id === targetAccountId);
				accountName = acc ? acc.name : targetAccountId;
			}

			const sendResult = await sendHubMessage({
				accountId: targetAccountId,
				recipient: chatId,
				body: text,
				...(replyToMessageId ? { replyToMessageId } : {}),
			});

			if (!sendResult.success) {
				return {
					content: [
						{
							type: "text",
							text: `Failed to send Telegram message to ${chatId}: ${sendResult.error ?? "Unknown delivery error"}`,
						},
					],
					details: {
						success: false,
						error: sendResult.error,
						chatId,
					},
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `Telegram message sent successfully to chat ${chatId} (Message ID: ${sendResult.messageId}, Account: ${accountName}).`,
					},
				],
				details: {
					success: true,
					messageId: sendResult.messageId,
					accountId: targetAccountId,
					chatId,
				},
			};
		},
	};
}

export function createHubSendSlackTool(): ToolDefinition<typeof HubSendSlackSchema> {
	return {
		name: HUB_SEND_SLACK_TOOL_NAME,
		label: "Send Slack Message",
		description:
			"Send an outbound message or reply to a Slack channel or user. Always confirm message body and target channel with the user before sending unless explicitly instructed.",
		parameters: HubSendSlackSchema,
		async execute(_toolCallId, params) {
			const { channel, text, accountId, threadTs } = params;
			let targetAccountId = accountId;
			let accountName = "";

			if (!targetAccountId) {
				const accounts = getAccounts("slack");
				const defaultAccount = accounts[0];
				if (!defaultAccount) {
					return {
						content: [
							{
								type: "text",
								text: "Error: No configured Slack account found. Please configure a Slack account in Personal Hub settings.",
							},
						],
						details: {
							success: false,
							error: "No configured Slack account found",
						},
					};
				}
				targetAccountId = defaultAccount.id;
				accountName = defaultAccount.name;
			} else {
				const accounts = getAccounts("slack");
				const acc = accounts.find((a) => a.id === targetAccountId);
				accountName = acc ? acc.name : targetAccountId;
			}

			const sendResult = await sendHubMessage({
				accountId: targetAccountId,
				recipient: channel,
				channelId: channel,
				body: text,
				...(threadTs ? { replyToMessageId: threadTs } : {}),
			});

			if (!sendResult.success) {
				return {
					content: [
						{
							type: "text",
							text: `Failed to send Slack message to ${channel}: ${sendResult.error ?? "Unknown delivery error"}`,
						},
					],
					details: {
						success: false,
						error: sendResult.error,
						channel,
					},
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `Slack message sent successfully to ${channel} (Message ID: ${sendResult.messageId}, Account: ${accountName}).`,
					},
				],
				details: {
					success: true,
					messageId: sendResult.messageId,
					accountId: targetAccountId,
					channel,
				},
			};
		},
	};
}

export function createHubSendDiscordTool(): ToolDefinition<typeof HubSendDiscordSchema> {
	return {
		name: HUB_SEND_DISCORD_TOOL_NAME,
		label: "Send Discord Message",
		description:
			"Send an outbound message or reply to a Discord channel. Always confirm message content and target channel with the user before sending unless explicitly instructed.",
		parameters: HubSendDiscordSchema,
		async execute(_toolCallId, params) {
			const { channelId, content, accountId, replyToMessageId } = params;
			let targetAccountId = accountId;
			let accountName = "";

			if (!targetAccountId) {
				const accounts = getAccounts("discord");
				const defaultAccount = accounts[0];
				if (!defaultAccount) {
					return {
						content: [
							{
								type: "text",
								text: "Error: No configured Discord account found. Please configure a Discord account in Personal Hub settings.",
							},
						],
						details: {
							success: false,
							error: "No configured Discord account found",
						},
					};
				}
				targetAccountId = defaultAccount.id;
				accountName = defaultAccount.name;
			} else {
				const accounts = getAccounts("discord");
				const acc = accounts.find((a) => a.id === targetAccountId);
				accountName = acc ? acc.name : targetAccountId;
			}

			const sendResult = await sendHubMessage({
				accountId: targetAccountId,
				recipient: channelId,
				channelId,
				body: content,
				...(replyToMessageId ? { replyToMessageId } : {}),
			});

			if (!sendResult.success) {
				return {
					content: [
						{
							type: "text",
							text: `Failed to send Discord message to ${channelId}: ${sendResult.error ?? "Unknown delivery error"}`,
						},
					],
					details: {
						success: false,
						error: sendResult.error,
						channelId,
					},
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `Discord message sent successfully to channel ${channelId} (Message ID: ${sendResult.messageId}, Account: ${accountName}).`,
					},
				],
				details: {
					success: true,
					messageId: sendResult.messageId,
					accountId: targetAccountId,
					channelId,
				},
			};
		},
	};
}

export function createHubSendWhatsAppTool(): ToolDefinition<typeof HubSendWhatsAppSchema> {
	return {
		name: HUB_SEND_WHATSAPP_TOOL_NAME,
		label: "Send WhatsApp Message",
		description:
			"Send an outbound message or reply to a WhatsApp contact or group. Always confirm message text and target recipient with the user before sending unless explicitly instructed.",
		parameters: HubSendWhatsAppSchema,
		async execute(_toolCallId, params) {
			const { recipient, text, accountId, replyToMessageId } = params;
			let targetAccountId = accountId;
			let accountName = "";

			if (!targetAccountId) {
				const accounts = getAccounts("whatsapp");
				const defaultAccount = accounts[0];
				if (!defaultAccount) {
					return {
						content: [
							{
								type: "text",
								text: "Error: No configured WhatsApp account found. Please configure a WhatsApp account in Personal Hub settings.",
							},
						],
						details: {
							success: false,
							error: "No configured WhatsApp account found",
						},
					};
				}
				targetAccountId = defaultAccount.id;
				accountName = defaultAccount.name;
			} else {
				const accounts = getAccounts("whatsapp");
				const acc = accounts.find((a) => a.id === targetAccountId);
				accountName = acc ? acc.name : targetAccountId;
			}

			const sendResult = await sendHubMessage({
				accountId: targetAccountId,
				recipient,
				body: text,
				...(replyToMessageId ? { replyToMessageId } : {}),
			});

			if (!sendResult.success) {
				return {
					content: [
						{
							type: "text",
							text: `Failed to send WhatsApp message to ${recipient}: ${sendResult.error ?? "Unknown delivery error"}`,
						},
					],
					details: {
						success: false,
						error: sendResult.error,
						recipient,
					},
				};
			}

			return {
				content: [
					{
						type: "text",
						text: `WhatsApp message sent successfully to ${recipient} (Message ID: ${sendResult.messageId}, Account: ${accountName}).`,
					},
				],
				details: {
					success: true,
					messageId: sendResult.messageId,
					accountId: targetAccountId,
					recipient,
				},
			};
		},
	};
}

const ACTION_TRIGGER_REGEX =
	/\b(urgent|asap|deadline|action required|review|please respond|critical|emergency|todo)\b/i;

export function createHubSummarizeInboxTool(): ToolDefinition<typeof HubSummarizeInboxSchema> {
	return {
		name: HUB_SUMMARIZE_INBOX_TOOL_NAME,
		label: "Summarize Inbox & Activity",
		description:
			"Generate a structured daily briefing and digest of recent communications within a given timeframe (default: 24h), highlighting urgent unread items, channel breakdowns, active conversations, and extracting action items into agent tasks.",
		parameters: HubSummarizeInboxSchema,
		async execute(_toolCallId, params) {
			const windowHours = params.hours ?? 24;
			const since = Date.now() - windowHours * 3600 * 1000;
			const limit = params.limit ?? 50;

			const filter = {
				since,
				...(params.includeRead ? {} : { isRead: false }),
				...(params.accountId ? { accountId: params.accountId } : {}),
				...(params.provider ? { provider: params.provider } : {}),
				limit,
			};

			const msgResult = getMessages(filter);
			const dashboard = getDashboardSummary();
			const accounts = getAccounts();

			const urgentMessages = msgResult.messages.filter((m) => m.isUrgent);

			// Account breakdown counts
			const accountCounts = new Map<string, { total: number; urgent: number }>();
			for (const msg of msgResult.messages) {
				const existing = accountCounts.get(msg.accountId) ?? { total: 0, urgent: 0 };
				existing.total++;
				if (msg.isUrgent) existing.urgent++;
				accountCounts.set(msg.accountId, existing);
			}

			// Key senders grouping
			const senderCounts = new Map<string, { count: number; latestSubject?: string }>();
			for (const msg of msgResult.messages) {
				const key = `${msg.senderName} (${msg.senderAddress})`;
				const existing = senderCounts.get(key) ?? { count: 0 };
				existing.count++;
				if (msg.subject && !existing.latestSubject) {
					existing.latestSubject = msg.subject;
				}
				senderCounts.set(key, existing);
			}

			// Action item extraction
			const extractedTasks: HubAgentTask[] = [];
			if (params.extractTasks) {
				const existingTasks = getAgentTasks();
				const existingMessageIds = new Set(
					existingTasks.map((t) => t.sourceMessageId).filter(Boolean),
				);

				for (const msg of msgResult.messages) {
					const isActionable =
						msg.isUrgent ||
						ACTION_TRIGGER_REGEX.test(msg.subject ?? "") ||
						ACTION_TRIGGER_REGEX.test(msg.body);

					if (isActionable && !existingMessageIds.has(msg.id)) {
						const taskTitle = msg.subject
							? `Follow up on: ${msg.subject}`
							: `Reply to ${msg.senderName}`;
						const task: HubAgentTask = {
							id: `task_${randomUUID().slice(0, 8)}`,
							title: taskTitle,
							description: `Action item detected from ${msg.senderName}: "${msg.snippet}"`,
							status: "pending",
							sourceMessageId: msg.id,
							sourceAccountId: msg.accountId,
							suggestedAction: `Review message and draft reply to ${msg.senderAddress}`,
							createdAt: Date.now(),
						};
						saveAgentTask(task);
						extractedTasks.push(task);
						existingMessageIds.add(msg.id);
					}
				}
			}

			// Format briefing markdown
			const sections: string[] = [];

			sections.push(`# 📬 Personal Hub Executive Digest`);
			sections.push(
				`**Time Window:** Past ${windowHours} hours (since ${new Date(since).toLocaleString()})\n` +
					`**Analyzed:** ${msgResult.messages.length} message(s) (${params.includeRead ? "all" : "unread only"})\n` +
					`**Global Unread:** ${dashboard.totalUnread} across all ${dashboard.accounts.length} connected accounts`,
			);

			// Urgent Section
			if (urgentMessages.length > 0) {
				sections.push(`### 🚨 Urgent Attention Required (${urgentMessages.length})`);
				for (const u of urgentMessages) {
					sections.push(formatMessageItem(u));
				}
			} else {
				sections.push(`### 🚨 Urgent Attention Required\n*No urgent messages detected.*`);
			}

			// Account breakdown section
			sections.push(`### 📊 Channel & Account Activity`);
			if (accountCounts.size === 0) {
				sections.push(`*No activity in the selected window.*`);
			} else {
				for (const [accId, counts] of accountCounts.entries()) {
					const acc = accounts.find((a) => a.id === accId);
					const name = acc ? `${acc.name} (${acc.provider})` : accId;
					const urgentNote = counts.urgent > 0 ? ` (🚨 ${counts.urgent} urgent)` : "";
					sections.push(`- **${name}**: ${counts.total} message(s)${urgentNote}`);
				}
			}

			// Top senders section
			const topSenders = [...senderCounts.entries()]
				.sort((a, b) => b[1].count - a[1].count)
				.slice(0, 5);

			if (topSenders.length > 0) {
				sections.push(`### 👥 Top Active Senders`);
				for (const [sender, info] of topSenders) {
					const topic = info.latestSubject ? ` - "${info.latestSubject}"` : "";
					sections.push(`- **${sender}**: ${info.count} message(s)${topic}`);
				}
			}

			// Tasks section
			if (extractedTasks.length > 0) {
				sections.push(`### 📋 Newly Extracted Action Items (${extractedTasks.length})`);
				for (const t of extractedTasks) {
					sections.push(
						`- [${t.id}] **${t.title}**\n  ${t.description}\n  *Action:* ${t.suggestedAction}`,
					);
				}
			} else if (params.extractTasks) {
				sections.push(`### 📋 Extracted Action Items\n*No new action items detected to create.*`);
			}

			return {
				content: [{ type: "text", text: sections.join("\n\n") }],
				details: {
					hours: windowHours,
					totalAnalyzed: msgResult.messages.length,
					totalUnread: dashboard.totalUnread,
					urgentCount: urgentMessages.length,
					urgentMessages,
					extractedTasks,
					topSenders: topSenders.map(([sender, data]) => ({ sender, ...data })),
				},
			};
		},
	};
}

// --- Extension Factory for Pi Runtime Registration ---

export function hubToolsExtension(pi: ExtensionAPI): void {
	pi.registerTool(createHubListUnreadTool());
	pi.registerTool(createHubSearchMessagesTool());
	pi.registerTool(createHubSendEmailTool());
	pi.registerTool(createHubSendTelegramTool());
	pi.registerTool(createHubSendSlackTool());
	pi.registerTool(createHubSendDiscordTool());
	pi.registerTool(createHubSendWhatsAppTool());
	pi.registerTool(createHubSummarizeInboxTool());
}
