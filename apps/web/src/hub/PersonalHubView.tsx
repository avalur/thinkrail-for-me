import {
	type RemixiconComponentType,
	RiDashboardLine,
	RiDiscordLine,
	RiMailLine,
	RiRefreshLine,
	RiSettings3Line,
	RiSlackLine,
	RiSparkling2Line,
	RiTelegramLine,
	RiWhatsappLine,
} from "@remixicon/react";
import { useEffect } from "react";
import { useAppStore } from "../store";
import { getTransport } from "../transport";
import { AccountSettingsView } from "./AccountSettingsView";
import { DashboardView } from "./DashboardView";
import { HubAssistantSidebar } from "./HubAssistantSidebar";
import { ProxyEmbedView } from "./ProxyEmbedView";

interface NavItem {
	id: string;
	label: string;
	icon: RemixiconComponentType;
	providerMatch?: string[];
}

const NAV_ITEMS: NavItem[] = [
	{
		id: "dashboard",
		label: "Dashboard",
		icon: RiDashboardLine,
	},
	{
		id: "telegram",
		label: "Telegram",
		icon: RiTelegramLine,
		providerMatch: ["telegram"],
	},
	{
		id: "email_work",
		label: "Work Email",
		icon: RiMailLine,
		providerMatch: ["email_work"],
	},
	{
		id: "email_personal",
		label: "Personal Email",
		icon: RiMailLine,
		providerMatch: ["email_personal"],
	},
	{
		id: "slack",
		label: "Slack",
		icon: RiSlackLine,
		providerMatch: ["slack"],
	},
	{
		id: "discord",
		label: "Discord",
		icon: RiDiscordLine,
		providerMatch: ["discord"],
	},
	{
		id: "whatsapp",
		label: "WhatsApp",
		icon: RiWhatsappLine,
		providerMatch: ["whatsapp"],
	},
	{
		id: "accounts",
		label: "Accounts",
		icon: RiSettings3Line,
	},
];

export function PersonalHubView() {
	const activeTab = useAppStore((s) => s.hubActiveTab);
	const accounts = useAppStore((s) => s.hubAccounts);
	const dashboard = useAppStore((s) => s.hubDashboard);
	const syncing = useAppStore((s) => s.hubSyncing);
	const assistantOpen = useAppStore((s) => s.hubAssistantSidebarOpen);

	useEffect(() => {
		let isMounted = true;
		getTransport()
			.request("hub.getAccounts", {})
			.then((res) => {
				if (isMounted && res?.accounts) {
					useAppStore.getState().setHubAccounts(res.accounts);
				}
			})
			.catch(() => {});

		getTransport()
			.request("hub.getDashboardSummary", {})
			.then((summary) => {
				if (isMounted && summary) {
					useAppStore.getState().setHubDashboard(summary);
				}
			})
			.catch(() => {});

		return () => {
			isMounted = false;
		};
	}, []);

	const getItemUnread = (item: NavItem): number => {
		if (item.id === "dashboard") {
			return dashboard?.totalUnread ?? accounts.reduce((sum, a) => sum + (a.unreadCount || 0), 0);
		}
		if (item.providerMatch) {
			return accounts
				.filter((a) => item.providerMatch?.includes(a.provider))
				.reduce((sum, a) => sum + (a.unreadCount || 0), 0);
		}
		return 0;
	};

	const handleSync = async () => {
		try {
			useAppStore.getState().setHubSyncing(true);
			await getTransport().request("hub.syncNow", { force: true });
			const accRes = await getTransport().request("hub.getAccounts", {});
			if (accRes?.accounts) useAppStore.getState().setHubAccounts(accRes.accounts);
			const sumRes = await getTransport().request("hub.getDashboardSummary", {});
			if (sumRes) useAppStore.getState().setHubDashboard(sumRes);
		} catch (err) {
			useAppStore.getState().setHubError(err instanceof Error ? err.message : String(err));
		} finally {
			useAppStore.getState().setHubSyncing(false);
		}
	};

	return (
		<div
			data-testid="personal-hub-view"
			className="flex h-full min-h-0 min-w-0 overflow-hidden bg-container-content-bg"
		>
			{/* Left Navigation Rail */}
			<nav
				data-testid="hub-left-nav"
				className="flex w-60 shrink-0 flex-col justify-between border-r border-border-default bg-container-sidebar-bg p-8"
			>
				<div className="space-y-4">
					<div className="px-8 py-8 tr-text-eyebrow text-text-muted">Channels & Hub</div>

					<div className="space-y-2">
						{NAV_ITEMS.map((item) => {
							const Icon = item.icon;
							const isActive = activeTab === item.id;
							const unread = getItemUnread(item);

							return (
								<button
									key={item.id}
									type="button"
									data-testid={`hub-nav-tab-${item.id}`}
									onClick={() => useAppStore.getState().setHubActiveTab(item.id)}
									className={`flex w-full items-center justify-between rounded-[var(--radius-sm)] px-12 py-8 tr-text-action transition-colors ${
										isActive
											? "bg-control-bg-selected text-text-default shadow-xs"
											: "text-text-muted hover:bg-control-bg hover:text-text-default"
									}`}
								>
									<div className="flex items-center gap-12">
										<Icon
											className={`size-16 shrink-0 ${
												isActive ? "text-primary" : "text-text-muted"
											}`}
										/>
										<span className="truncate">{item.label}</span>
									</div>

									{unread > 0 ? (
										<span
											data-testid={`hub-nav-unread-${item.id}`}
											className={`inline-flex items-center justify-center rounded-full px-8 py-2 tr-text-label-pill ${
												item.id === "dashboard"
													? "bg-feedback-error-subtle text-feedback-error"
													: "bg-control-bg text-text-default"
											}`}
										>
											{unread > 99 ? "99+" : unread}
										</span>
									) : null}
								</button>
							);
						})}
					</div>
				</div>

				{/* Bottom Controls */}
				<div className="space-y-4 border-t border-border-default pt-8">
					<button
						type="button"
						data-testid="hub-sync-all-nav-btn"
						disabled={syncing}
						onClick={handleSync}
						className="flex w-full items-center gap-12 rounded-[var(--radius-sm)] px-12 py-8 tr-text-action text-text-muted transition-colors hover:bg-control-bg hover:text-text-default disabled:opacity-50"
					>
						<RiRefreshLine
							className={`size-16 shrink-0 ${syncing ? "animate-spin text-primary" : ""}`}
						/>
						<span>{syncing ? "Syncing..." : "Sync All"}</span>
					</button>

					<button
						type="button"
						data-testid="toggle-assistant-sidebar-btn"
						onClick={() => useAppStore.getState().toggleHubAssistantSidebar()}
						className={`flex w-full items-center justify-between rounded-[var(--radius-sm)] px-12 py-8 tr-text-action transition-colors ${
							assistantOpen
								? "bg-control-bg-selected text-text-default"
								: "text-text-muted hover:bg-control-bg hover:text-text-default"
						}`}
					>
						<div className="flex items-center gap-12">
							<RiSparkling2Line className="size-16 shrink-0 text-primary" />
							<span>Assistant</span>
						</div>
						<span className="tr-text-metadata text-text-muted">
							{assistantOpen ? "Open" : "Closed"}
						</span>
					</button>
				</div>
			</nav>

			{/* Center Content Viewport */}
			<main className="flex-1 min-h-0 min-w-0 overflow-hidden bg-container-content-bg">
				{activeTab === "dashboard" ? (
					<DashboardView />
				) : activeTab === "accounts" ? (
					<AccountSettingsView />
				) : (
					<ProxyEmbedView tab={activeTab} />
				)}
			</main>

			{/* Right Collapsible AI Assistant Sidebar */}
			<HubAssistantSidebar />
		</div>
	);
}
