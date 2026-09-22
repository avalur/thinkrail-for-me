import {
	type RemixiconComponentType,
	RiChat1Line,
	RiCheckDoubleLine,
	RiDashboardLine,
	RiDiscordLine,
	RiExternalLinkLine,
	RiMailLine,
	RiRefreshLine,
	RiSettings3Line,
	RiSlackLine,
	RiSparkling2Line,
	RiTelegramLine,
	RiWhatsappLine,
} from "@remixicon/react";
import type { HubAccountProvider } from "@thinkrail/contracts";
import type React from "react";
import { useEffect, useState } from "react";
import { useAppStore } from "../store";
import { getTransport } from "../transport";
import { AccountSettingsView } from "./AccountSettingsView";
import { DashboardView } from "./DashboardView";
import { HubAssistantSidebar } from "./HubAssistantSidebar";
import { HubContextMenu, type HubContextMenuItem } from "./HubContextMenu";
import { HubMessagesView } from "./HubMessagesView";
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
		id: "messages",
		label: "Messages",
		icon: RiChat1Line,
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
	const [contextMenu, setContextMenu] = useState<{
		x: number;
		y: number;
		items: HubContextMenuItem[];
	} | null>(null);

	const handleContextMenu = (e: React.MouseEvent, item: NavItem) => {
		e.preventDefault();
		const menuItems: HubContextMenuItem[] = [];

		if (item.id === "dashboard") {
			menuItems.push(
				{
					label: "Отметить всё прочитанным",
					icon: RiCheckDoubleLine,
					action: async () => {
						await getTransport().request("hub.markRead", { all: true });
						const accRes = (await getTransport().request("hub.getAccounts", {})) as {
							accounts?: unknown[];
						};
						if (accRes?.accounts) useAppStore.getState().setHubAccounts(accRes.accounts as any);
						const dashRes = await getTransport().request("hub.getDashboardSummary", {});
						if (dashRes) useAppStore.getState().setHubDashboard(dashRes as any);
					},
				},
				{
					label: "Синхронизировать всё",
					icon: RiRefreshLine,
					action: () => void handleSync(),
				},
			);
		} else if (item.providerMatch && item.providerMatch.length > 0) {
			const provider = item.providerMatch[0] as HubAccountProvider;
			const acc = accounts.find((a) => a.provider === provider);

			menuItems.push(
				{
					label: "Показать непрочитанные",
					icon: RiMailLine,
					action: () => {
						useAppStore.getState().setHubActiveTab(item.id);
						useAppStore.getState().setHubViewPreference(item.id, "messages");
						useAppStore.getState().setHubFilter({ provider, unreadOnly: true });
					},
				},
				{
					label: "Показать все сообщения (БД)",
					icon: RiChat1Line,
					action: () => {
						useAppStore.getState().setHubActiveTab(item.id);
						useAppStore.getState().setHubViewPreference(item.id, "messages");
						useAppStore.getState().setHubFilter({ provider, unreadOnly: false });
					},
				},
				{
					label: "Отметить прочитанными",
					icon: RiCheckDoubleLine,
					action: async () => {
						if (acc) {
							await getTransport().request("hub.markRead", { accountId: acc.id, all: true });
						} else {
							await getTransport().request("hub.markRead", { provider, all: true });
						}
						const accRes = (await getTransport().request("hub.getAccounts", {})) as {
							accounts?: unknown[];
						};
						if (accRes?.accounts) useAppStore.getState().setHubAccounts(accRes.accounts as any);
						const dashRes = await getTransport().request("hub.getDashboardSummary", {});
						if (dashRes) useAppStore.getState().setHubDashboard(dashRes as any);
					},
				},
				{
					label: "Открыть веб-клиент",
					icon: RiExternalLinkLine,
					action: () => {
						useAppStore.getState().setHubActiveTab(item.id);
						useAppStore.getState().setHubViewPreference(item.id, "web");
					},
				},
				{
					label: "Синхронизировать",
					icon: RiRefreshLine,
					action: async () => {
						if (acc) {
							await getTransport().request("hub.syncNow", { accountId: acc.id, force: true });
						} else {
							await handleSync();
						}
					},
				},
			);
		} else if (item.id === "messages") {
			menuItems.push(
				{
					label: "Показать только непрочитанные",
					icon: RiMailLine,
					action: () => {
						useAppStore.getState().setHubActiveTab("messages");
						useAppStore.getState().setHubFilter({ unreadOnly: true });
					},
				},
				{
					label: "Отметить всё прочитанным",
					icon: RiCheckDoubleLine,
					action: async () => {
						await getTransport().request("hub.markRead", { all: true });
						const accRes = (await getTransport().request("hub.getAccounts", {})) as {
							accounts?: unknown[];
						};
						if (accRes?.accounts) useAppStore.getState().setHubAccounts(accRes.accounts as any);
						const dashRes = await getTransport().request("hub.getDashboardSummary", {});
						if (dashRes) useAppStore.getState().setHubDashboard(dashRes as any);
					},
				},
			);
		}

		if (menuItems.length > 0) {
			setContextMenu({
				x: e.clientX,
				y: e.clientY,
				items: menuItems,
			});
		}
	};

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
				className="flex w-[240px] shrink-0 flex-col justify-between border-r border-border-default bg-container-sidebar-bg p-8"
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
									onContextMenu={(e) => handleContextMenu(e, item)}
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
				) : activeTab === "messages" ? (
					<HubMessagesView />
				) : activeTab === "accounts" ? (
					<AccountSettingsView />
				) : (
					<div data-testid="hub-proxy-embed-view" className="h-full min-h-0 flex-1">
						<ProxyEmbedView tab={activeTab} />
					</div>
				)}
			</main>

			{/* Right Collapsible AI Assistant Sidebar */}
			<HubAssistantSidebar />

			{/* Context Menu for Channels & Hub */}
			{contextMenu && (
				<HubContextMenu
					x={contextMenu.x}
					y={contextMenu.y}
					onClose={() => setContextMenu(null)}
					items={contextMenu.items}
				/>
			)}
		</div>
	);
}
