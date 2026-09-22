import type { Workspace } from "./domain";

export const HUB_PROJECT_ID = "hub-personal-agent";
export const HUB_WORKSPACE_ID = "hub-personal-agent";

export const HUB_WORKSPACE: Workspace = {
	id: HUB_WORKSPACE_ID,
	projectId: HUB_PROJECT_ID,
	name: "Personal Agent",
	branch: "main",
	baseBranch: "main",
	worktreePath: "",
	kind: "default",
};

export const HUB_ACCOUNT_PROVIDERS = [
	"telegram",
	"email_work",
	"email_personal",
	"slack",
	"discord",
	"whatsapp",
] as const;

export type HubAccountProvider = (typeof HUB_ACCOUNT_PROVIDERS)[number];

export function isHubAccountProvider(val: unknown): val is HubAccountProvider {
	return typeof val === "string" && (HUB_ACCOUNT_PROVIDERS as readonly string[]).includes(val);
}

export const HUB_ACCOUNT_STATUSES = [
	"connected",
	"connecting",
	"disconnected",
	"error",
	"syncing",
] as const;

export type HubAccountStatus = (typeof HUB_ACCOUNT_STATUSES)[number];

export function isHubAccountStatus(val: unknown): val is HubAccountStatus {
	return typeof val === "string" && (HUB_ACCOUNT_STATUSES as readonly string[]).includes(val);
}

export interface HubAccount {
	id: string;
	provider: HubAccountProvider;
	name: string;
	email?: string;
	status: HubAccountStatus;
	unreadCount: number;
	lastSyncAt: number | null;
	error?: string;
	metadata?: Record<string, unknown>;
}

export interface HubAccountSummary {
	id: string;
	provider: HubAccountProvider;
	name: string;
	email?: string;
	status: HubAccountStatus;
	unreadCount: number;
	lastSyncAt: number | null;
}

export const HUB_CHANNEL_KINDS = ["dm", "channel", "group", "folder", "thread"] as const;

export type HubChannelKind = (typeof HUB_CHANNEL_KINDS)[number];

export function isHubChannelKind(val: unknown): val is HubChannelKind {
	return typeof val === "string" && (HUB_CHANNEL_KINDS as readonly string[]).includes(val);
}

export interface HubChannel {
	id: string;
	accountId: string;
	remoteId: string;
	name: string;
	kind?: HubChannelKind;
	unreadCount: number;
	lastMessageAt?: number | null;
	metadata?: Record<string, unknown>;
}

export interface HubAttachment {
	id: string;
	name: string;
	mimeType?: string;
	size?: number;
	url?: string;
}

export interface HubMessage {
	id: string;
	accountId: string;
	remoteId: string;
	channelId?: string;
	senderName: string;
	senderAddress: string;
	recipientAddress?: string;
	subject?: string;
	body: string;
	snippet: string;
	timestamp: number;
	isRead: boolean;
	isUrgent: boolean;
	hasAttachments: boolean;
	attachments?: HubAttachment[];
	metadata?: Record<string, unknown>;
}

export const HUB_AGENT_TASK_STATUSES = [
	"pending",
	"running",
	"completed",
	"failed",
	"cancelled",
] as const;

export type HubAgentTaskStatus = (typeof HUB_AGENT_TASK_STATUSES)[number];

export function isHubAgentTaskStatus(val: unknown): val is HubAgentTaskStatus {
	return typeof val === "string" && (HUB_AGENT_TASK_STATUSES as readonly string[]).includes(val);
}

export interface HubAgentTask {
	id: string;
	title: string;
	description?: string;
	status: HubAgentTaskStatus;
	sourceMessageId?: string;
	sourceAccountId?: string;
	suggestedAction?: string;
	createdAt: number;
	completedAt?: number;
	metadata?: Record<string, unknown>;
}

export interface HubFilter {
	accountId?: string;
	channelId?: string;
	provider?: HubAccountProvider;
	isRead?: boolean;
	isUrgent?: boolean;
	query?: string;
	since?: number;
	limit?: number;
	offset?: number;
}

export interface HubDashboardSummary {
	totalUnread: number;
	accounts: HubAccountSummary[];
	urgentMessages: HubMessage[];
	recentActivity: HubMessage[];
	suggestedAgentTasks: string[];
	activeAgentTasks?: HubAgentTask[];
}

export interface HubSendMessageParams {
	accountId: string;
	recipient: string;
	body: string;
	channelId?: string;
	subject?: string;
	replyToMessageId?: string;
}

export interface HubSendMessageResult {
	success: boolean;
	messageId?: string;
	error?: string;
}

export interface HubMarkReadParams {
	messageIds?: string[];
	accountId?: string;
	channelId?: string;
	provider?: HubAccountProvider;
	all?: boolean;
}

export interface HubSyncNowParams {
	accountId?: string;
	force?: boolean;
}

export interface HubSyncNowResult {
	synced: boolean;
	accountIds?: string[];
	error?: string;
}

export type HubMessageReceivedPayload = HubMessage;

export interface HubAccountStatusChangedPayload {
	accountId: string;
	status: HubAccountStatus;
	unreadCount: number;
	error?: string;
	metadata?: Record<string, unknown>;
}

export interface HubSyncStatusPayload {
	accountId?: string;
	isSyncing: boolean;
	progress?: string;
	error?: string;
}

export function isHubAccount(val: unknown): val is HubAccount {
	if (!val || typeof val !== "object") return false;
	const acc = val as Partial<HubAccount>;
	return (
		typeof acc.id === "string" &&
		isHubAccountProvider(acc.provider) &&
		typeof acc.name === "string" &&
		isHubAccountStatus(acc.status) &&
		typeof acc.unreadCount === "number" &&
		(acc.lastSyncAt === null || typeof acc.lastSyncAt === "number")
	);
}

export function isHubChannel(val: unknown): val is HubChannel {
	if (!val || typeof val !== "object") return false;
	const ch = val as Partial<HubChannel>;
	return (
		typeof ch.id === "string" &&
		typeof ch.accountId === "string" &&
		typeof ch.remoteId === "string" &&
		typeof ch.name === "string" &&
		typeof ch.unreadCount === "number" &&
		(ch.kind === undefined || isHubChannelKind(ch.kind))
	);
}

export function isHubMessage(val: unknown): val is HubMessage {
	if (!val || typeof val !== "object") return false;
	const msg = val as Partial<HubMessage>;
	return (
		typeof msg.id === "string" &&
		typeof msg.accountId === "string" &&
		typeof msg.remoteId === "string" &&
		typeof msg.senderName === "string" &&
		typeof msg.senderAddress === "string" &&
		typeof msg.body === "string" &&
		typeof msg.snippet === "string" &&
		typeof msg.timestamp === "number" &&
		typeof msg.isRead === "boolean" &&
		typeof msg.isUrgent === "boolean" &&
		typeof msg.hasAttachments === "boolean"
	);
}

export function isHubAgentTask(val: unknown): val is HubAgentTask {
	if (!val || typeof val !== "object") return false;
	const task = val as Partial<HubAgentTask>;
	return (
		typeof task.id === "string" &&
		typeof task.title === "string" &&
		isHubAgentTaskStatus(task.status) &&
		typeof task.createdAt === "number"
	);
}

export function isHubDashboardSummary(val: unknown): val is HubDashboardSummary {
	if (!val || typeof val !== "object") return false;
	const d = val as Partial<HubDashboardSummary>;
	return (
		typeof d.totalUnread === "number" &&
		Array.isArray(d.accounts) &&
		Array.isArray(d.urgentMessages) &&
		Array.isArray(d.recentActivity) &&
		Array.isArray(d.suggestedAgentTasks)
	);
}
