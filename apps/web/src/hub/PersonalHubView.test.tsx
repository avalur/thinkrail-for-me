import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { HubAccount, HubDashboardSummary, HubMessage, Workspace } from "@thinkrail/contracts";
import { renderToStaticMarkup } from "react-dom/server";

const pendingRequests: { method: string; params: unknown }[] = [];
const actualTransport = await import("../transport");
mock.module("../transport", () => ({
	...actualTransport,
	getTransport: () => ({
		request: async (method: string, params: unknown) => {
			pendingRequests.push({ method, params });
			if (method === "hub.getAccounts") {
				return { accounts: useAppStore.getState().hubAccounts };
			}
			if (method === "hub.getDashboardSummary") {
				return (
					useAppStore.getState().hubDashboard ?? {
						totalUnread: 0,
						accounts: [],
						urgentMessages: [],
						recentActivity: [],
						suggestedAgentTasks: [],
					}
				);
			}
			if (method === "hub.markRead") {
				return { ok: true, modifiedCount: 1 };
			}
			if (method === "hub.syncNow") {
				return { synced: true };
			}
			return {};
		},
	}),
}));

const { useAppStore, selectHubTotalUnread } = await import("../store");
const { TooltipProvider } = await import("../components/ui/tooltip");
const { PersonalHubView } = await import("./PersonalHubView");
const { HubAssistantSidebar } = await import("./HubAssistantSidebar");
const { Shell } = await import("../shell/Shell");

function renderShell(): string {
	return renderToStaticMarkup(
		<TooltipProvider>
			<Shell />
		</TooltipProvider>,
	);
}

const sampleAccounts: HubAccount[] = [
	{
		id: "acc-tg",
		provider: "telegram",
		name: "My Telegram",
		status: "connected",
		unreadCount: 4,
		lastSyncAt: 1700000000000,
	},
	{
		id: "acc-email-work",
		provider: "email_work",
		name: "Work Email",
		email: "alex@company.com",
		status: "connected",
		unreadCount: 2,
		lastSyncAt: 1700000000000,
	},
	{
		id: "acc-email-personal",
		provider: "email_personal",
		name: "Personal Email",
		email: "alex@personal.me",
		status: "connected",
		unreadCount: 0,
		lastSyncAt: 1700000000000,
	},
	{
		id: "acc-slack",
		provider: "slack",
		name: "Company Slack",
		status: "connected",
		unreadCount: 5,
		lastSyncAt: 1700000000000,
	},
];

const sampleDashboard: HubDashboardSummary = {
	totalUnread: 11,
	accounts: sampleAccounts.map((a) => ({
		id: a.id,
		provider: a.provider,
		name: a.name,
		email: a.email,
		status: a.status,
		unreadCount: a.unreadCount,
		lastSyncAt: a.lastSyncAt,
	})),
	urgentMessages: [
		{
			id: "msg-urgent-1",
			accountId: "acc-email-work",
			remoteId: "rem-101",
			senderName: "CEO Alice",
			senderAddress: "alice@company.com",
			subject: "Urgent: Board meeting rescheduled",
			snippet: "Please see the new time for the board meeting...",
			body: "Full body of urgent email",
			timestamp: Date.now() - 1000 * 60 * 15,
			isRead: false,
			isUrgent: true,
			hasAttachments: false,
		},
	],
	recentActivity: [
		{
			id: "msg-recent-1",
			accountId: "acc-tg",
			remoteId: "rem-201",
			senderName: "Dev Chat",
			senderAddress: "@devgroup",
			snippet: "Deployment pipeline succeeded",
			body: "Deployment pipeline succeeded for commit abc",
			timestamp: Date.now() - 1000 * 60 * 5,
			isRead: false,
			isUrgent: false,
			hasAttachments: false,
		},
	],
	suggestedAgentTasks: [
		"Draft reply to CEO Alice regarding board meeting",
		"Summarize 4 unread messages in Telegram",
	],
};

const sampleWorkspace: Workspace = {
	id: "ws-test-1",
	projectId: "proj-1",
	name: "feature-branch",
	branch: "feature-branch",
	worktreePath: "/tmp/worktree/feature-branch",
	baseBranch: "main",
};

beforeEach(() => {
	pendingRequests.length = 0;
	useAppStore.setState({
		viewMode: "hub",
		hubActiveTab: "dashboard",
		hubAccounts: sampleAccounts,
		hubDashboard: sampleDashboard,
		hubMessages: [],
		hubLoading: false,
		hubSyncing: false,
		hubError: null,
		hubAssistantSidebarOpen: true,
		activeWorkspaceId: null,
		projects: [{ id: "proj-1", name: "ThinkRail Repo", path: "/tmp/thinkrail" }],
		workspaces: { "proj-1": [sampleWorkspace] },
		contextProjectId: "proj-1",
	});
});

describe("PersonalHubView Navigation and Badges", () => {
	test("renders left navigation rail with all tabs and section title", () => {
		const html = renderToStaticMarkup(<PersonalHubView />);
		expect(html).toContain('data-testid="personal-hub-view"');
		expect(html).toContain('data-testid="hub-left-nav"');
		expect(html).toContain("Channels &amp; Hub");
		expect(html).toContain('data-testid="hub-nav-tab-dashboard"');
		expect(html).toContain('data-testid="hub-nav-tab-telegram"');
		expect(html).toContain('data-testid="hub-nav-tab-email_work"');
		expect(html).toContain('data-testid="hub-nav-tab-email_personal"');
		expect(html).toContain('data-testid="hub-nav-tab-slack"');
		expect(html).toContain('data-testid="hub-nav-tab-discord"');
		expect(html).toContain('data-testid="hub-nav-tab-whatsapp"');
		expect(html).toContain('data-testid="hub-nav-tab-accounts"');
	});

	test("displays accurate unread badge counts on channels and total on dashboard", () => {
		const html = renderToStaticMarkup(<PersonalHubView />);
		// Dashboard total unread: 11
		expect(html).toContain('data-testid="hub-nav-unread-dashboard"');
		expect(html).toContain(">11<");

		// Telegram: 4 unread
		expect(html).toContain('data-testid="hub-nav-unread-telegram"');
		expect(html).toContain(">4<");

		// Work email: 2 unread
		expect(html).toContain('data-testid="hub-nav-unread-email_work"');
		expect(html).toContain(">2<");

		// Slack: 5 unread
		expect(html).toContain('data-testid="hub-nav-unread-slack"');
		expect(html).toContain(">5<");

		// Personal email has 0 unread, so no badge
		expect(html).not.toContain('data-testid="hub-nav-unread-email_personal"');
	});

	test("formats unread badge counts over 99 as 99+", () => {
		useAppStore.setState({
			hubAccounts: [
				{
					id: "acc-tg",
					provider: "telegram",
					name: "Big Channel",
					status: "connected",
					unreadCount: 150,
					lastSyncAt: Date.now(),
				},
			],
			hubDashboard: {
				...sampleDashboard,
				totalUnread: 150,
			},
		});

		const html = renderToStaticMarkup(<PersonalHubView />);
		expect(html).toContain(">99+<");
	});

	test("renders bottom rail controls including Sync All and Assistant toggle", () => {
		const html = renderToStaticMarkup(<PersonalHubView />);
		expect(html).toContain('data-testid="hub-sync-all-nav-btn"');
		expect(html).toContain("Sync All");
		expect(html).toContain('data-testid="toggle-assistant-sidebar-btn"');
		expect(html).toContain("Assistant");
	});
});

describe("Central Viewport Switching", () => {
	test("renders DashboardView when activeTab is dashboard", () => {
		useAppStore.setState({ hubActiveTab: "dashboard" });
		const html = renderToStaticMarkup(<PersonalHubView />);
		expect(html).toContain('data-testid="hub-dashboard-view"');
		expect(html).toContain("Executive Daily Briefing");
		expect(html).toContain("Urgent Triage Queue");
		expect(html).toContain("CEO Alice");
		expect(html).toContain("Urgent: Board meeting rescheduled");
		expect(html).toContain("Recent Communications");
		expect(html).toContain("Deployment pipeline succeeded");
	});

	test("renders AccountSettingsView when activeTab is accounts", () => {
		useAppStore.setState({ hubActiveTab: "accounts" });
		const html = renderToStaticMarkup(<PersonalHubView />);
		expect(html).toContain('data-testid="account-settings-view"');
		expect(html).toContain("Configured Accounts");
		expect(html).toContain("My Telegram");
		expect(html).toContain("Work Email");
		expect(html).toContain("Company Slack");
		expect(html).toContain("Privacy &amp; Security");
	});

	test("renders ProxyEmbedView with iframe when activeTab is a messenger/email channel", () => {
		useAppStore.setState({ hubActiveTab: "telegram" });
		const html = renderToStaticMarkup(<PersonalHubView />);
		expect(html).toContain('data-testid="proxy-embed-view"');
		expect(html).toContain('data-testid="proxy-embed-toolbar"');
		expect(html).toContain("Telegram Web");
		expect(html).toContain("Proxy Active");
		expect(html).toContain('data-testid="proxy-ask-agent-btn"');
		expect(html).toContain('data-testid="proxy-reload-btn"');
		expect(html).toContain('data-testid="proxy-external-btn"');
		expect(html).toContain('src="/proxy/telegram"');
	});

	test("renders ProxyEmbedView for work email", () => {
		useAppStore.setState({ hubActiveTab: "email_work" });
		const html = renderToStaticMarkup(<PersonalHubView />);
		expect(html).toContain("Work Email");
		expect(html).toContain('src="/proxy/email_work"');
	});
});

describe("HubAssistantSidebar", () => {
	test("renders assistant sidebar with quick action chips and conversation shortcuts", () => {
		const html = renderToStaticMarkup(<HubAssistantSidebar />);
		expect(html).toContain('data-testid="hub-assistant-sidebar"');
		expect(html).toContain("AI Assistant");
		expect(html).toContain("Personal Agent");
		expect(html).toContain("Summarize unread");
		expect(html).toContain("Draft reply");
	});

	test("respects closed state when hubAssistantSidebarOpen is false", () => {
		useAppStore.setState({ hubAssistantSidebarOpen: false });
		const html = renderToStaticMarkup(<HubAssistantSidebar />);
		expect(html).toBe("");
	});
});

describe("Shell Mode Switching and Header Integration", () => {
	test("renders mode switcher with IDE and Personal Hub tabs in Shell header", () => {
		useAppStore.setState({ viewMode: "ide" });
		const html = renderShell();
		expect(html).toContain('data-testid="mode-switcher"');
		expect(html).toContain('data-testid="mode-switch-ide"');
		expect(html).toContain('data-testid="mode-switch-hub"');
		expect(html).toContain('aria-selected="true"');
	});

	test("displays total unread badge pill on Personal Hub header button when unread > 0", () => {
		useAppStore.setState({
			hubDashboard: sampleDashboard,
		});
		expect(selectHubTotalUnread(useAppStore.getState())).toBe(11);

		const html = renderShell();
		expect(html).toContain('data-testid="hub-header-unread-badge"');
		expect(html).toContain(">11<");
	});

	test("hides unread badge on header button when unread is 0", () => {
		useAppStore.setState({
			hubDashboard: {
				...sampleDashboard,
				totalUnread: 0,
				accounts: sampleAccounts.map((a) => ({ ...a, unreadCount: 0 })),
			},
			hubAccounts: sampleAccounts.map((a) => ({ ...a, unreadCount: 0 })),
		});
		expect(selectHubTotalUnread(useAppStore.getState())).toBe(0);

		const html = renderShell();
		expect(html).not.toContain('data-testid="hub-header-unread-badge"');
	});

	test("renders PersonalHubView layout when viewMode is hub", () => {
		useAppStore.setState({ viewMode: "hub" });
		const html = renderShell();
		expect(html).toContain('data-testid="hub-shell-layout"');
		expect(html).toContain('data-testid="personal-hub-view"');
		expect(html).not.toContain('data-testid="workspace-shell-layout"');
	});

	test("renders WorkspaceWorkbench or Welcome when viewMode is ide", () => {
		useAppStore.setState({
			viewMode: "ide",
			activeWorkspaceId: "ws-test-1",
		});
		const html = renderShell();
		expect(html).toContain('data-testid="workspace-shell-layout"');
		expect(html).not.toContain('data-testid="hub-shell-layout"');
	});

	test("switching modes preserves active workspace state non-destructively in store", () => {
		// Set active workspace
		useAppStore.setState({
			activeWorkspaceId: "ws-test-1",
			viewMode: "ide",
		});
		expect(useAppStore.getState().activeWorkspaceId).toBe("ws-test-1");

		// Switch to hub
		useAppStore.getState().setViewMode("hub");
		expect(useAppStore.getState().viewMode).toBe("hub");
		// Workspace ID is still intact
		expect(useAppStore.getState().activeWorkspaceId).toBe("ws-test-1");

		// Switch back to ide
		useAppStore.getState().setViewMode("ide");
		expect(useAppStore.getState().viewMode).toBe("ide");
		expect(useAppStore.getState().activeWorkspaceId).toBe("ws-test-1");
	});
});

describe("Store Hub Push Event Reducers", () => {
	test("applyHubMessageReceived appends message and updates unread counts", () => {
		useAppStore.setState({
			hubAccounts: sampleAccounts,
			hubDashboard: sampleDashboard,
			hubMessages: [],
		});

		const newMsg: HubMessage = {
			id: "msg-incoming-99",
			accountId: "acc-tg",
			remoteId: "rem-99",
			senderName: "Bob",
			senderAddress: "@bob",
			snippet: "Hello from Telegram!",
			body: "Hello from Telegram! Are you free?",
			timestamp: Date.now(),
			isRead: false,
			isUrgent: true,
			hasAttachments: false,
		};

		useAppStore.getState().applyHubMessageReceived(newMsg);

		const state = useAppStore.getState();
		expect(state.hubMessages.some((m) => m.id === "msg-incoming-99")).toBe(true);

		// Telegram unread should have incremented from 4 to 5
		const tg = state.hubAccounts.find((a) => a.id === "acc-tg");
		expect(tg?.unreadCount).toBe(5);

		// Total unread in dashboard should have incremented from 11 to 12
		expect(state.hubDashboard?.totalUnread).toBe(12);

		// Urgent messages list should include new urgent message
		expect(state.hubDashboard?.urgentMessages.some((m) => m.id === "msg-incoming-99")).toBe(true);
	});

	test("applyHubAccountStatusChanged updates account status and unread count", () => {
		useAppStore.setState({ hubAccounts: sampleAccounts });

		useAppStore.getState().applyHubAccountStatusChanged({
			accountId: "acc-tg",
			status: "error",
			unreadCount: 7,
			error: "Network timeout connecting to Telegram API",
		});

		const state = useAppStore.getState();
		const tg = state.hubAccounts.find((a) => a.id === "acc-tg");
		expect(tg?.status).toBe("error");
		expect(tg?.unreadCount).toBe(7);
		expect(tg?.error).toBe("Network timeout connecting to Telegram API");
	});

	test("applyHubSyncStatus tracks background syncing state and errors", () => {
		useAppStore.setState({ hubSyncing: false, hubError: null });

		useAppStore.getState().applyHubSyncStatus({
			isSyncing: true,
			progress: "Fetching IMAP mailbox",
		});
		expect(useAppStore.getState().hubSyncing).toBe(true);

		useAppStore.getState().applyHubSyncStatus({
			isSyncing: false,
			error: "Authentication failed",
		});
		expect(useAppStore.getState().hubSyncing).toBe(false);
		expect(useAppStore.getState().hubError).toBe("Authentication failed");
	});
});
