import {
	type RemixiconComponentType,
	RiAlertLine,
	RiArrowRightSLine,
	RiChat1Line,
	RiCheckDoubleLine,
	RiCheckLine,
	RiDiscordLine,
	RiExternalLinkLine,
	RiInboxLine,
	RiMailLine,
	RiRefreshLine,
	RiSlackLine,
	RiSparkling2Line,
	RiTaskLine,
	RiTelegramLine,
	RiTimeLine,
	RiWhatsappLine,
} from "@remixicon/react";
import type { HubAccountProvider, HubMessage } from "@thinkrail/contracts";
import type React from "react";
import { useState } from "react";
import { useAppStore } from "../store";
import { getTransport } from "../transport";
import { HubContextMenu, type HubContextMenuItem } from "./HubContextMenu";

const PROVIDER_ICONS: Record<HubAccountProvider, RemixiconComponentType> = {
	telegram: RiTelegramLine,
	email_work: RiMailLine,
	email_personal: RiMailLine,
	slack: RiSlackLine,
	discord: RiDiscordLine,
	whatsapp: RiWhatsappLine,
};

const PROVIDER_LABELS: Record<HubAccountProvider, string> = {
	telegram: "Telegram",
	email_work: "Work Mail",
	email_personal: "Personal Mail",
	slack: "Slack",
	discord: "Discord",
	whatsapp: "WhatsApp",
};

export function DashboardView() {
	const dashboard = useAppStore((s) => s.hubDashboard);
	const accounts = useAppStore((s) => s.hubAccounts);
	const syncing = useAppStore((s) => s.hubSyncing);
	const [markingReadId, setMarkingReadId] = useState<string | null>(null);
	const [contextMenu, setContextMenu] = useState<{
		x: number;
		y: number;
		items: HubContextMenuItem[];
	} | null>(null);

	const totalUnread =
		dashboard?.totalUnread ?? accounts.reduce((sum, acc) => sum + (acc.unreadCount || 0), 0);
	const urgentMessages = dashboard?.urgentMessages ?? [];
	const recentActivity = dashboard?.recentActivity ?? [];
	const connectedAccountsCount = accounts.filter((a) => a.status === "connected").length;

	const handleChannelContextMenu = (
		e: React.MouseEvent,
		ch: { id: string; label: string; provider: HubAccountProvider },
	) => {
		e.preventDefault();
		const matchedAccounts = accounts.filter((a) => a.provider === ch.provider);
		const acc = matchedAccounts[0];

		const menuItems: HubContextMenuItem[] = [
			{
				label: "Показать непрочитанные",
				icon: RiMailLine,
				action: () => {
					useAppStore.getState().setHubActiveTab(ch.id);
					useAppStore.getState().setHubViewPreference(ch.id, "messages");
					useAppStore.getState().setHubFilter({ provider: ch.provider, unreadOnly: true });
				},
			},
			{
				label: "Показать все сообщения (БД)",
				icon: RiChat1Line,
				action: () => {
					useAppStore.getState().setHubActiveTab(ch.id);
					useAppStore.getState().setHubViewPreference(ch.id, "messages");
					useAppStore.getState().setHubFilter({ provider: ch.provider, unreadOnly: false });
				},
			},
			{
				label: "Отметить прочитанными",
				icon: RiCheckDoubleLine,
				action: async () => {
					if (acc) {
						await getTransport().request("hub.markRead", { accountId: acc.id, all: true });
					} else {
						await getTransport().request("hub.markRead", { provider: ch.provider, all: true });
					}
					const summary = await getTransport().request("hub.getDashboardSummary", {});
					if (summary) useAppStore.getState().setHubDashboard(summary);
					const accRes = await getTransport().request("hub.getAccounts", {});
					if (accRes?.accounts) useAppStore.getState().setHubAccounts(accRes.accounts);
				},
			},
			{
				label: "Открыть веб-клиент",
				icon: RiExternalLinkLine,
				action: () => {
					useAppStore.getState().setHubActiveTab(ch.id);
					useAppStore.getState().setHubViewPreference(ch.id, "web");
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
		];

		setContextMenu({
			x: e.clientX,
			y: e.clientY,
			items: menuItems,
		});
	};

	const handleSync = async () => {
		try {
			useAppStore.getState().setHubSyncing(true);
			await getTransport().request("hub.syncNow", { force: true });
			const summary = await getTransport().request("hub.getDashboardSummary", {});
			if (summary) useAppStore.getState().setHubDashboard(summary);
			const accRes = await getTransport().request("hub.getAccounts", {});
			if (accRes?.accounts) useAppStore.getState().setHubAccounts(accRes.accounts);
		} catch (err) {
			useAppStore.getState().setHubError(err instanceof Error ? err.message : String(err));
		} finally {
			useAppStore.getState().setHubSyncing(false);
		}
	};

	const handleMarkRead = async (messageId: string) => {
		try {
			setMarkingReadId(messageId);
			await getTransport().request("hub.markRead", { messageIds: [messageId] });
			const summary = await getTransport().request("hub.getDashboardSummary", {});
			if (summary) useAppStore.getState().setHubDashboard(summary);
		} catch (err) {
			useAppStore.getState().setHubError(err instanceof Error ? err.message : String(err));
		} finally {
			setMarkingReadId(null);
		}
	};

	const handleQuickPrompt = (promptText: string) => {
		useAppStore.getState().setHubAssistantSidebarOpen(true);
		window.dispatchEvent(
			new CustomEvent("thinkrail:hub-prompt", { detail: { prompt: promptText } }),
		);
	};

	const formatTime = (ts: number): string => {
		const diff = Date.now() - ts;
		if (diff < 60_000) return "just now";
		if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
		if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
		return new Date(ts).toLocaleDateString();
	};

	return (
		<div
			data-testid="hub-dashboard-view"
			className="h-full overflow-y-auto bg-container-content-bg p-24"
		>
			<div className="mx-auto max-w-6xl space-y-24">
				{/* Header & Quick Sync */}
				<div className="flex flex-col justify-between gap-12 sm:flex-row sm:items-center">
					<div>
						<h1 className="tr-heading-sm text-text-default">Executive Daily Briefing</h1>
						<p className="tr-text-ui text-text-muted">
							Aggregated communication stream, urgent triage queue, and AI agent assistance.
						</p>
					</div>

					<button
						type="button"
						data-testid="dashboard-sync-btn"
						disabled={syncing}
						onClick={handleSync}
						className="inline-flex items-center gap-8 rounded-[var(--radius-sm)] bg-control-bg px-12 py-8 tr-text-ui text-text-default shadow-xs transition-colors hover:bg-control-bg-hovered disabled:opacity-50"
					>
						<RiRefreshLine className={`size-16 ${syncing ? "animate-spin" : ""}`} />
						<span>{syncing ? "Syncing…" : "Sync Hub"}</span>
					</button>
				</div>

				{/* Metric Briefing Cards */}
				<div className="grid grid-cols-2 gap-12 sm:grid-cols-4">
					<div
						data-testid="stat-total-unread"
						className="flex flex-col justify-between rounded-[var(--radius-md)] border border-border-default bg-container-sidebar-bg p-16 shadow-xs"
					>
						<span className="tr-text-eyebrow text-text-muted">Total Unread</span>
						<div className="mt-8 flex items-baseline gap-8">
							<span className="tr-heading-xl text-text-default">{totalUnread}</span>
							<span className="tr-text-metadata text-text-muted">messages</span>
						</div>
					</div>

					<div
						data-testid="stat-urgent-messages"
						className="flex flex-col justify-between rounded-[var(--radius-md)] border border-border-default bg-container-sidebar-bg p-16 shadow-xs"
					>
						<span className="tr-text-eyebrow text-feedback-error">Urgent Triage</span>
						<div className="mt-8 flex items-baseline gap-8">
							<span className="tr-heading-xl text-feedback-error">{urgentMessages.length}</span>
							<span className="tr-text-metadata text-text-muted">requiring action</span>
						</div>
					</div>

					<div
						data-testid="stat-accounts-connected"
						className="flex flex-col justify-between rounded-[var(--radius-md)] border border-border-default bg-container-sidebar-bg p-16 shadow-xs"
					>
						<span className="tr-text-eyebrow text-text-muted">Channels Active</span>
						<div className="mt-8 flex items-baseline gap-8">
							<span className="tr-heading-xl text-text-default">{connectedAccountsCount}</span>
							<span className="tr-text-metadata text-text-muted">
								/ {accounts.length} configured
							</span>
						</div>
					</div>

					<div
						data-testid="stat-suggested-tasks"
						className="flex flex-col justify-between rounded-[var(--radius-md)] border border-border-default bg-container-sidebar-bg p-16 shadow-xs"
					>
						<span className="tr-text-eyebrow text-primary">Agent Tasks</span>
						<div className="mt-8 flex items-baseline gap-8">
							<span className="tr-heading-xl text-primary">
								{dashboard?.suggestedAgentTasks?.length ?? 3}
							</span>
							<span className="tr-text-metadata text-text-muted">actions available</span>
						</div>
					</div>
				</div>

				{/* Quick Agent Actions Bar */}
				<div className="flex flex-wrap items-center gap-8 rounded-[var(--radius-md)] border border-border-default bg-container-header-bg p-12">
					<div className="flex items-center gap-8 px-4 tr-text-eyebrow text-primary">
						<RiSparkling2Line className="size-16" />
						<span>Agent Shortcuts:</span>
					</div>
					<button
						type="button"
						data-testid="action-summarize-inbox"
						onClick={() => handleQuickPrompt("Summarize all unread messages from today")}
						className="rounded-full bg-control-bg px-12 py-4 tr-text-action text-text-default transition-colors hover:bg-control-bg-hovered"
					>
						Summarize unread inbox
					</button>
					<button
						type="button"
						data-testid="action-draft-standup"
						onClick={() =>
							handleQuickPrompt(
								"Draft a daily standup update based on today's messages and recent work",
							)
						}
						className="rounded-full bg-control-bg px-12 py-4 tr-text-action text-text-default transition-colors hover:bg-control-bg-hovered"
					>
						Draft daily standup update
					</button>
					<button
						type="button"
						data-testid="action-urgent-brief"
						onClick={() => handleQuickPrompt("Brief me on the urgent items needing attention")}
						className="rounded-full bg-control-bg px-12 py-4 tr-text-action text-text-default transition-colors hover:bg-control-bg-hovered"
					>
						Check urgent emails
					</button>
					<button
						type="button"
						data-testid="action-triage-chats"
						onClick={() =>
							handleQuickPrompt(
								"Triage recent messages and mentions across Slack, Discord, and WhatsApp",
							)
						}
						className="rounded-full bg-control-bg px-12 py-4 tr-text-action text-text-default transition-colors hover:bg-control-bg-hovered"
					>
						Triage chats & mentions
					</button>
				</div>

				{/* Multi-Channel Communications Strip */}
				<div
					data-testid="multi-channel-overview"
					className="space-y-12 rounded-[var(--radius-md)] border border-border-default bg-container-header-bg p-16"
				>
					<div className="flex items-center justify-between">
						<div className="flex items-center gap-8">
							<RiInboxLine className="size-16 text-primary" />
							<h2 className="tr-title-section text-text-default">Communication Channels</h2>
						</div>
						<span className="tr-text-metadata text-text-muted">
							Click channel to open web client
						</span>
					</div>

					<div className="grid grid-cols-2 gap-8 sm:grid-cols-3 lg:grid-cols-6">
						{[
							{ id: "slack", label: "Slack", provider: "slack" as const, icon: RiSlackLine },
							{
								id: "discord",
								label: "Discord",
								provider: "discord" as const,
								icon: RiDiscordLine,
							},
							{
								id: "whatsapp",
								label: "WhatsApp",
								provider: "whatsapp" as const,
								icon: RiWhatsappLine,
							},
							{
								id: "telegram",
								label: "Telegram",
								provider: "telegram" as const,
								icon: RiTelegramLine,
							},
							{
								id: "email_work",
								label: "Work Email",
								provider: "email_work" as const,
								icon: RiMailLine,
							},
							{
								id: "email_personal",
								label: "Personal Email",
								provider: "email_personal" as const,
								icon: RiMailLine,
							},
						].map((ch) => {
							const Icon = ch.icon;
							const matchedAccounts = accounts.filter((a) => a.provider === ch.provider);
							const chUnread = matchedAccounts.reduce((sum, a) => sum + (a.unreadCount || 0), 0);
							const isConnected = matchedAccounts.some((a) => a.status === "connected");

							return (
								<button
									key={ch.id}
									type="button"
									data-testid={`channel-card-${ch.id}`}
									onClick={() => useAppStore.getState().setHubActiveTab(ch.id)}
									onContextMenu={(e) => handleChannelContextMenu(e, ch)}
									className="flex flex-col justify-between rounded-[var(--radius-sm)] border border-border-default bg-container-sidebar-bg p-12 text-left transition-colors hover:bg-control-bg"
								>
									<div className="flex items-center justify-between">
										<div className="flex size-24 items-center justify-center rounded bg-control-bg text-primary">
											<Icon className="size-14" />
										</div>
										{chUnread > 0 ? (
											<span
												data-testid={`channel-unread-${ch.id}`}
												className="rounded-full bg-feedback-error-subtle px-8 py-2 tr-text-label-pill text-feedback-error"
											>
												{chUnread > 99 ? "99+" : chUnread}
											</span>
										) : (
											<span
												className={`size-8 rounded-full ${
													isConnected ? "bg-feedback-success" : "bg-text-muted"
												}`}
											/>
										)}
									</div>
									<div className="mt-8">
										<span className="tr-title-compact text-text-default block truncate">
											{ch.label}
										</span>
										<span className="tr-text-metadata text-text-muted block">
											{isConnected
												? chUnread > 0
													? `${chUnread} unread`
													: "Connected"
												: "Inactive"}
										</span>
									</div>
								</button>
							);
						})}
					</div>
				</div>

				{/* Main Content Grid: Urgent Triage on Left, Recent Activity & Tasks on Right */}
				<div className="grid gap-24 lg:grid-cols-12">
					{/* Left Column: Urgent Triage Queue */}
					<div className="space-y-12 lg:col-span-7">
						<div className="flex items-center justify-between">
							<div className="flex items-center gap-8">
								<RiAlertLine className="size-18 text-feedback-error" />
								<h2 className="tr-title-section text-text-default">Urgent Triage Queue</h2>
								<span className="rounded-full bg-feedback-error-subtle px-8 py-2 tr-text-emphasis text-feedback-error">
									{urgentMessages.length}
								</span>
							</div>
						</div>

						{urgentMessages.length === 0 ? (
							<div
								data-testid="urgent-empty-state"
								className="flex flex-col items-center justify-center rounded-[var(--radius-md)] border border-border-default bg-container-sidebar-bg p-24 text-center"
							>
								<div className="flex size-40 items-center justify-center rounded-full bg-feedback-success-subtle text-feedback-success">
									<RiCheckLine className="size-24" />
								</div>
								<h3 className="mt-12 tr-title-compact text-text-default">All caught up!</h3>
								<p className="mt-4 tr-text-metadata text-text-muted">
									No urgent messages waiting for your attention right now.
								</p>
							</div>
						) : (
							<div data-testid="urgent-messages-list" className="space-y-8">
								{urgentMessages.map((msg: HubMessage) => {
									const account = accounts.find((a) => a.id === msg.accountId);
									const provider = account?.provider ?? "email_work";
									const Icon = PROVIDER_ICONS[provider] ?? RiMailLine;

									return (
										<div
											key={msg.id}
											data-testid={`urgent-message-${msg.id}`}
											className="rounded-[var(--radius-md)] border border-feedback-error-muted bg-container-sidebar-bg p-12 shadow-xs transition-colors hover:border-feedback-error"
										>
											<div className="flex items-start justify-between gap-8">
												<div className="flex items-center gap-8">
													<div className="flex size-24 items-center justify-center rounded bg-control-bg text-primary">
														<Icon className="size-14" />
													</div>
													<span className="tr-title-compact text-text-default">
														{msg.senderName || msg.senderAddress}
													</span>
													<span className="tr-text-metadata text-text-muted">
														via {PROVIDER_LABELS[provider]}
													</span>
												</div>
												<span className="inline-flex items-center gap-4 tr-text-metadata text-text-muted">
													<RiTimeLine className="size-12" />
													{formatTime(msg.timestamp)}
												</span>
											</div>

											{msg.subject ? (
												<h4 className="mt-8 tr-title-compact text-text-default">{msg.subject}</h4>
											) : null}

											<p className="mt-4 tr-text-metadata text-text-muted line-clamp-2">
												{msg.snippet || msg.body}
											</p>

											<div className="mt-12 flex items-center justify-end gap-8 border-t border-border-default pt-8">
												<button
													type="button"
													onClick={() =>
														handleQuickPrompt(
															`Draft a reply to ${msg.senderName} regarding: "${msg.subject ?? msg.snippet}"`,
														)
													}
													className="inline-flex items-center gap-4 rounded-[var(--radius-xs)] bg-control-bg px-8 py-4 tr-text-action text-text-default transition-colors hover:bg-control-bg-hovered"
												>
													<RiSparkling2Line className="size-12 text-primary" />
													<span>Draft Reply</span>
												</button>

												<button
													type="button"
													disabled={markingReadId === msg.id}
													onClick={() => handleMarkRead(msg.id)}
													className="inline-flex items-center gap-4 rounded-[var(--radius-xs)] border border-border-default bg-control-bg px-8 py-4 tr-text-action text-text-muted transition-colors hover:bg-control-bg-hovered hover:text-text-default"
												>
													<RiCheckLine className="size-12" />
													<span>{markingReadId === msg.id ? "Marking…" : "Mark Read"}</span>
												</button>
											</div>
										</div>
									);
								})}
							</div>
						)}
					</div>

					{/* Right Column: Recent Activity Feed & Suggested Tasks */}
					<div className="space-y-24 lg:col-span-5">
						{/* Suggested Tasks */}
						<div className="space-y-12">
							<div className="flex items-center gap-8">
								<RiTaskLine className="size-18 text-primary" />
								<h2 className="tr-title-section text-text-default">Suggested Actions</h2>
							</div>

							<div className="space-y-8">
								{(dashboard?.suggestedAgentTasks && dashboard.suggestedAgentTasks.length > 0
									? dashboard.suggestedAgentTasks
									: [
											"Review unread newsletters & digests",
											"Prepare daily schedule & action items",
											"Archive resolved customer support inquiries",
										]
								).map((taskText, idx) => (
									<div
										key={idx}
										data-testid={`suggested-task-${idx}`}
										className="flex items-center justify-between rounded-[var(--radius-md)] border border-border-default bg-container-sidebar-bg p-12 transition-colors hover:bg-container-header-bg"
									>
										<span className="tr-text-action text-text-default">{taskText}</span>
										<button
											type="button"
											onClick={() => handleQuickPrompt(`Help me with: ${taskText}`)}
											className="flex size-24 items-center justify-center rounded-[var(--radius-xs)] text-primary hover:bg-control-bg"
											title="Ask agent to help"
										>
											<RiArrowRightSLine className="size-18" />
										</button>
									</div>
								))}
							</div>
						</div>

						{/* Recent Activity */}
						<div className="space-y-12">
							<div className="flex items-center gap-8">
								<RiInboxLine className="size-18 text-text-muted" />
								<h2 className="tr-title-section text-text-default">Recent Communications</h2>
							</div>

							{recentActivity.length === 0 ? (
								<div
									data-testid="activity-empty-state"
									className="rounded-[var(--radius-md)] border border-border-default bg-container-sidebar-bg p-16 text-center tr-text-metadata text-text-muted"
								>
									No recent messages synced yet.
								</div>
							) : (
								<div data-testid="recent-activity-list" className="space-y-8">
									{recentActivity.slice(0, 10).map((msg: HubMessage) => {
										const account = accounts.find((a) => a.id === msg.accountId);
										const provider = account?.provider ?? "email_work";
										const Icon = PROVIDER_ICONS[provider] ?? RiMailLine;

										return (
											<div
												key={msg.id}
												className="flex items-start gap-12 rounded-[var(--radius-sm)] border border-border-default bg-container-sidebar-bg p-12"
											>
												<div className="flex size-28 shrink-0 items-center justify-center rounded bg-control-bg text-primary">
													<Icon className="size-16" />
												</div>
												<div className="min-w-0 flex-1 space-y-2">
													<div className="flex items-center justify-between gap-4">
														<span className="truncate tr-title-compact text-text-default">
															{msg.senderName || msg.senderAddress}
														</span>
														<span className="shrink-0 tr-text-metadata text-text-muted">
															{formatTime(msg.timestamp)}
														</span>
													</div>
													<p className="truncate tr-text-metadata text-text-muted">
														{msg.subject ? `${msg.subject} · ` : ""}
														{msg.snippet || msg.body}
													</p>
												</div>
											</div>
										);
									})}
								</div>
							)}
						</div>
					</div>
				</div>
			</div>

			{/* Context Menu for Channels */}
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
