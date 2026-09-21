import {
	type RemixiconComponentType,
	RiAlertLine,
	RiDiscordLine,
	RiMailLine,
	RiRefreshLine,
	RiShieldLine,
	RiSlackLine,
	RiTelegramLine,
	RiTimeLine,
	RiWhatsappLine,
} from "@remixicon/react";
import type { HubAccount, HubAccountProvider } from "@thinkrail/contracts";
import { useState } from "react";
import { useAppStore } from "../store";
import { getTransport } from "../transport";

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
	email_work: "Work Email",
	email_personal: "Personal Email",
	slack: "Slack",
	discord: "Discord",
	whatsapp: "WhatsApp",
};

export function AccountSettingsView() {
	const accounts = useAppStore((s) => s.hubAccounts);
	const syncing = useAppStore((s) => s.hubSyncing);
	const [syncingAccountId, setSyncingAccountId] = useState<string | null>(null);

	const handleSyncAll = async () => {
		try {
			useAppStore.getState().setHubSyncing(true);
			await getTransport().request("hub.syncNow", { force: true });
			const accountsRes = await getTransport().request("hub.getAccounts", {});
			if (accountsRes?.accounts) {
				useAppStore.getState().setHubAccounts(accountsRes.accounts);
			}
			const summaryRes = await getTransport().request("hub.getDashboardSummary", {});
			if (summaryRes) {
				useAppStore.getState().setHubDashboard(summaryRes);
			}
		} catch (err) {
			useAppStore.getState().setHubError(err instanceof Error ? err.message : String(err));
		} finally {
			useAppStore.getState().setHubSyncing(false);
		}
	};

	const handleSyncAccount = async (accountId: string) => {
		try {
			setSyncingAccountId(accountId);
			await getTransport().request("hub.syncNow", { accountId, force: true });
			const accountsRes = await getTransport().request("hub.getAccounts", {});
			if (accountsRes?.accounts) {
				useAppStore.getState().setHubAccounts(accountsRes.accounts);
			}
		} catch (err) {
			useAppStore.getState().setHubError(err instanceof Error ? err.message : String(err));
		} finally {
			setSyncingAccountId(null);
		}
	};

	const formatLastSync = (timestamp: number | null | undefined): string => {
		if (!timestamp) return "Never synced";
		const diff = Date.now() - timestamp;
		if (diff < 60_000) return "Just now";
		if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
		if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
		return new Date(timestamp).toLocaleDateString();
	};

	return (
		<div
			data-testid="account-settings-view"
			className="h-full overflow-y-auto bg-container-content-bg p-24"
		>
			<div className="mx-auto max-w-4xl space-y-24">
				{/* Top Header */}
				<div className="flex flex-col justify-between gap-12 sm:flex-row sm:items-center">
					<div>
						<h1 className="tr-heading-sm text-text-default">Accounts & Integrations</h1>
						<p className="tr-text-ui text-text-muted">
							Manage connected messaging channels, credentials, and background sync settings.
						</p>
					</div>

					<button
						type="button"
						data-testid="sync-all-accounts-btn"
						disabled={syncing}
						onClick={handleSyncAll}
						className="inline-flex items-center gap-8 rounded-[var(--radius-sm)] bg-control-primary-bg px-12 py-8 tr-text-ui text-control-primary-text shadow-xs transition-colors hover:bg-control-primary-bg-hovered disabled:opacity-50"
					>
						<RiRefreshLine className={`size-16 ${syncing ? "animate-spin" : ""}`} />
						<span>{syncing ? "Syncing All…" : "Sync All Now"}</span>
					</button>
				</div>

				{/* Privacy and Storage Banner */}
				<div className="flex items-start gap-12 rounded-[var(--radius-md)] border border-border-default bg-container-header-bg p-16">
					<RiShieldLine className="mt-2 size-20 shrink-0 text-primary" />
					<div className="space-y-4 tr-text-metadata text-text-muted">
						<span className="tr-title-compact text-text-default">Privacy & Security First</span>
						<p>
							All credentials, tokens, and local message logs are stored strictly on your local
							machine in{" "}
							<code className="rounded bg-control-bg px-4 py-2 tr-code-text-small text-text-default">
								~/.thinkrail/hub-accounts.json
							</code>{" "}
							with user-only permissions (0600). No messages or tokens are sent to external
							analytics or third-party cloud servers.
						</p>
					</div>
				</div>

				{/* Accounts List */}
				<div className="space-y-12">
					<h2 className="tr-text-eyebrow text-text-muted">
						Configured Accounts ({accounts.length})
					</h2>

					{accounts.length === 0 ? (
						<div
							data-testid="no-accounts-notice"
							className="rounded-[var(--radius-md)] border border-border-default bg-container-sidebar-bg p-24 text-center"
						>
							<p className="tr-text-ui text-text-default">No accounts configured yet.</p>
							<p className="mt-4 tr-text-metadata text-text-muted">
								Add accounts to{" "}
								<code className="rounded bg-control-bg px-4 py-2 tr-code-text-small">
									~/.thinkrail/hub-accounts.json
								</code>{" "}
								or configure connectors.
							</p>
						</div>
					) : (
						<div className="grid gap-12 sm:grid-cols-2">
							{accounts.map((acc: HubAccount) => {
								const Icon = PROVIDER_ICONS[acc.provider] ?? RiMailLine;
								const isAccSyncing = syncing || syncingAccountId === acc.id;

								return (
									<div
										key={acc.id}
										data-testid={`account-card-${acc.id}`}
										className="flex flex-col justify-between rounded-[var(--radius-md)] border border-border-default bg-container-sidebar-bg p-16 shadow-xs"
									>
										<div className="space-y-8">
											<div className="flex items-start justify-between">
												<div className="flex items-center gap-12">
													<div className="flex size-36 items-center justify-center rounded-[var(--radius-sm)] bg-control-bg text-primary">
														<Icon className="size-20" />
													</div>
													<div>
														<h3 className="tr-title-compact text-text-default">{acc.name}</h3>
														<span className="tr-text-metadata text-text-muted">
															{PROVIDER_LABELS[acc.provider]}
															{acc.email ? ` · ${acc.email}` : ""}
														</span>
													</div>
												</div>

												{acc.unreadCount > 0 ? (
													<span
														data-testid={`account-unread-${acc.id}`}
														className="rounded-full bg-feedback-error-subtle px-8 py-2 tr-text-emphasis text-feedback-error"
													>
														{acc.unreadCount} unread
													</span>
												) : null}
											</div>

											{acc.error ? (
												<div className="flex items-center gap-8 rounded bg-feedback-error-subtle p-8 tr-text-metadata text-feedback-error">
													<RiAlertLine className="size-14 shrink-0" />
													<span className="truncate">{acc.error}</span>
												</div>
											) : null}
										</div>

										<div className="mt-16 flex items-center justify-between border-t border-border-default pt-12 tr-text-metadata text-text-muted">
											<div className="flex items-center gap-8">
												<span
													className={`size-8 rounded-full ${
														acc.status === "connected"
															? "bg-feedback-success"
															: acc.status === "syncing"
																? "bg-feedback-warning animate-pulse"
																: acc.status === "error"
																	? "bg-feedback-error"
																	: "bg-text-muted"
													}`}
												/>
												<span className="capitalize">{acc.status}</span>
												<span>·</span>
												<span className="inline-flex items-center gap-4">
													<RiTimeLine className="size-12" />
													{formatLastSync(acc.lastSyncAt)}
												</span>
											</div>

											<button
												type="button"
												data-testid={`sync-account-${acc.id}-btn`}
												disabled={isAccSyncing}
												onClick={() => handleSyncAccount(acc.id)}
												className="inline-flex items-center gap-4 rounded-[var(--radius-xs)] bg-control-bg px-8 py-4 tr-text-action text-text-default transition-colors hover:bg-control-bg-hovered disabled:opacity-50"
											>
												<RiRefreshLine
													className={`size-12 ${isAccSyncing ? "animate-spin" : ""}`}
												/>
												<span>{isAccSyncing ? "Syncing…" : "Sync"}</span>
											</button>
										</div>
									</div>
								);
							})}
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
