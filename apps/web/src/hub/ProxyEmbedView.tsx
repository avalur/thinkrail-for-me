import {
	type RemixiconComponentType,
	RiAlertLine,
	RiChat1Line,
	RiDiscordLine,
	RiDownloadCloud2Line,
	RiExternalLinkLine,
	RiGlobalLine,
	RiHistoryLine,
	RiInformationLine,
	RiLockLine,
	RiMailLine,
	RiQrCodeLine,
	RiRefreshLine,
	RiRobotLine,
	RiShieldCheckLine,
	RiSlackLine,
	RiSparkling2Line,
	RiTelegramLine,
	RiWhatsappLine,
} from "@remixicon/react";
import type { HubAccount, HubAccountProvider } from "@thinkrail/contracts";
import React, { useState } from "react";
import { selectHubViewPreference, useAppStore } from "../store";
import { getTransport } from "../transport";
import { HubMessagesView } from "./HubMessagesView";

interface ProxyServiceConfig {
	name: string;
	description: string;
	defaultUrl: string;
	icon: RemixiconComponentType;
}

const SERVICES: Record<string, ProxyServiceConfig> = {
	telegram: {
		name: "Telegram Web",
		description: "Telegram Web client loaded via local streaming reverse-proxy",
		defaultUrl: "https://web.telegram.org/k/",
		icon: RiTelegramLine,
	},
	email_work: {
		name: "Work Email",
		description: "Work webmail client (Gmail / Outlook / Roundcube)",
		defaultUrl: "https://mail.google.com",
		icon: RiMailLine,
	},
	email_personal: {
		name: "Personal Email",
		description: "Personal webmail client",
		defaultUrl: "https://mail.google.com",
		icon: RiMailLine,
	},
	slack: {
		name: "Slack",
		description: "Slack web client for workspaces & direct messages",
		defaultUrl: "https://app.slack.com",
		icon: RiSlackLine,
	},
	discord: {
		name: "Discord",
		description: "Discord web client for community servers & voice/text",
		defaultUrl: "https://discord.com/channels/@me",
		icon: RiDiscordLine,
	},
	whatsapp: {
		name: "WhatsApp Web",
		description: "WhatsApp Web messenger client",
		defaultUrl: "https://web.whatsapp.com",
		icon: RiWhatsappLine,
	},
};

export function isDesktopRuntime(): boolean {
	const g =
		typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : null;
	if (!g) return false;
	const w = g as unknown as Record<string, unknown>;
	return (
		Boolean(w.__electrobunWebviewId) ||
		Boolean(w.__THINKRAIL_NATIVE_UPDATES__) ||
		(typeof customElements !== "undefined" && Boolean(customElements.get("electrobun-webview")))
	);
}

export function ProxyEmbedView({ tab }: { tab: string }) {
	const [reloadKey, setReloadKey] = useState(0);
	const service = SERVICES[tab] ?? {
		name: tab.charAt(0).toUpperCase() + tab.slice(1),
		description: `Embedded view for ${tab}`,
		defaultUrl: `/proxy/${tab}`,
		icon: RiTelegramLine,
	};
	const Icon = service.icon;
	const proxyUrl =
		tab === "discord"
			? "/proxy/discord/channels/@me"
			: tab === "telegram"
				? "/proxy/telegram/k/"
				: `/proxy/${tab}`;
	const isDesktop = isDesktopRuntime();

	const handleReload = () => {
		setReloadKey((prev) => prev + 1);
	};

	const handleOpenExternal = () => {
		const targetUrl = service.defaultUrl.startsWith("http") ? service.defaultUrl : proxyUrl;
		window.open(
			targetUrl,
			`thinkrail_${tab}`,
			"noopener,noreferrer,width=1200,height=850,menubar=no,toolbar=no",
		);
	};

	const handleAskAgent = () => {
		useAppStore.getState().setHubAssistantSidebarOpen(true);
	};

	const accounts = useAppStore((s) => s.hubAccounts);
	const waAccount = accounts.find((a) => a.provider === "whatsapp");
	const discordAccount = accounts.find((a) => a.provider === "discord");
	const tgAccount = accounts.find((a) => a.provider === "telegram");
	const qrCodeDataUrl = waAccount?.metadata?.qrCodeDataUrl as string | undefined;
	const tgQrCodeDataUrl = tgAccount?.metadata?.qrCodeDataUrl as string | undefined;
	const channelViewMode = useAppStore((s) => selectHubViewPreference(s, tab));
	const setChannelViewMode = (pref: "messages" | "web") => {
		useAppStore.getState().setHubViewPreference(tab, pref);
	};

	const [tgPassword, setTgPassword] = useState("");
	const [isSubmittingTgPassword, setIsSubmittingTgPassword] = useState(false);
	const [tgPasswordFeedback, setTgPasswordFeedback] = useState<{
		text: string;
		isError: boolean;
	} | null>(null);
	const [showTgPasswordInput, setShowTgPasswordInput] = useState(false);

	const handleSubmitTgPassword = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!tgPassword.trim() || isSubmittingTgPassword) return;
		setIsSubmittingTgPassword(true);
		setTgPasswordFeedback(null);
		try {
			const res = (await getTransport().request("hub.submitTelegramPassword", {
				accountId: "account_telegram",
				password: tgPassword.trim(),
			})) as { ok: boolean; status?: string; waitingForScan?: boolean; error?: string };
			if (res.ok) {
				setTgPasswordFeedback({
					text: res.waitingForScan
						? "Пароль сохранен. Теперь отсканируйте QR-код для завершения входа."
						: "Пароль отправлен. Завершаем авторизацию...",
					isError: false,
				});
			} else {
				setTgPasswordFeedback({
					text: res.error || "Не удалось отправить пароль",
					isError: true,
				});
			}
		} catch (err: unknown) {
			setTgPasswordFeedback({
				text: err instanceof Error ? err.message : String(err),
				isError: true,
			});
		} finally {
			setIsSubmittingTgPassword(false);
		}
	};

	return (
		<div
			data-testid="proxy-embed-view"
			data-tab={tab}
			className="flex h-full min-h-0 flex-col overflow-hidden bg-container-content-bg"
		>
			{/* Proxy Toolbar */}
			<div
				data-testid="proxy-embed-toolbar"
				className="flex h-44 shrink-0 items-center justify-between border-b border-border-default bg-container-header-bg px-16"
			>
				<div className="flex items-center gap-12">
					<Icon className="size-18 text-primary" />
					<span data-testid="proxy-service-name" className="tr-title-compact text-text-default">
						{service.name}
					</span>
					<span className="hidden items-center gap-4 rounded-full bg-feedback-success-subtle px-8 py-2 tr-text-emphasis text-feedback-success sm:inline-flex">
						<RiShieldCheckLine className="size-12" />
						{isDesktop ? "Native Webview Active" : "Proxy Active"}
					</span>
					{tab === "whatsapp" && waAccount?.status === "connected" && (
						<span
							data-testid="whatsapp-agent-connected-badge"
							className="inline-flex items-center gap-4 rounded-full bg-feedback-success-subtle px-8 py-2 tr-text-emphasis text-feedback-success"
						>
							<RiShieldCheckLine className="size-12" />
							Агент подключен
						</span>
					)}
					{tab === "discord" && discordAccount?.status === "connected" && (
						<span
							data-testid="discord-agent-connected-badge"
							className="inline-flex items-center gap-4 rounded-full bg-feedback-success-subtle px-8 py-2 tr-text-emphasis text-feedback-success"
						>
							<RiShieldCheckLine className="size-12" />
							Подключен
						</span>
					)}
					{tab === "discord" && discordAccount?.status !== "connected" && (
						<span
							data-testid="discord-agent-disconnected-badge"
							className="inline-flex items-center gap-4 rounded-full bg-feedback-warning-subtle px-8 py-2 tr-text-emphasis text-feedback-warning"
						>
							<RiAlertLine className="size-12" />
							Требуется настройка
						</span>
					)}
					{tab === "whatsapp" && waAccount?.status !== "connected" && (
						<span
							data-testid="whatsapp-agent-connecting-badge"
							className="inline-flex items-center gap-4 rounded-full bg-feedback-warning-subtle px-8 py-2 tr-text-emphasis text-feedback-warning"
						>
							<RiQrCodeLine className="size-12" />
							{waAccount?.status === "connecting" && qrCodeDataUrl
								? "Ожидание сканирования QR"
								: "Агент не привязан"}
						</span>
					)}
					{tab === "telegram" && tgAccount?.status === "connected" && (
						<span
							data-testid="telegram-agent-connected-badge"
							className="inline-flex items-center gap-4 rounded-full bg-feedback-success-subtle px-8 py-2 tr-text-emphasis text-feedback-success"
						>
							<RiShieldCheckLine className="size-12" />
							{tgAccount?.metadata?.connectedUser
								? String(tgAccount.metadata.connectedUser)
								: "Подключен"}
						</span>
					)}
					{tab === "telegram" && tgAccount?.status !== "connected" && (
						<span
							data-testid="telegram-agent-connecting-badge"
							className="inline-flex items-center gap-4 rounded-full bg-feedback-warning-subtle px-8 py-2 tr-text-emphasis text-feedback-warning"
						>
							<RiQrCodeLine className="size-12" />
							{tgAccount?.metadata?.needs2fa
								? "Требуется 2FA пароль"
								: tgAccount?.status === "connecting" && tgQrCodeDataUrl
									? "Ожидание сканирования QR"
									: "Не привязан"}
						</span>
					)}
					<span className="hidden tr-text-metadata text-text-muted md:inline">
						{service.description}
					</span>
				</div>

				<div className="flex items-center gap-8">
					{/* View mode toggle: Messages vs Web client */}
					<div
						data-testid="hub-channel-view-toggle"
						className="flex items-center rounded-[var(--radius-sm)] border border-border-default bg-control-bg p-2"
					>
						<button
							type="button"
							data-testid="toggle-view-messages-btn"
							onClick={() => setChannelViewMode("messages")}
							className={`flex items-center gap-4 rounded-[var(--radius-xs)] px-8 py-2 tr-text-action transition-colors ${
								channelViewMode === "messages"
									? "bg-control-primary-bg text-control-primary-text"
									: "text-text-muted hover:text-text-default"
							}`}
							title="Показать сообщения из локальной базы данных SQLite"
						>
							<RiChat1Line className="size-14" />
							<span className="hidden sm:inline">Сообщения (БД)</span>
						</button>
						<button
							type="button"
							data-testid="toggle-view-web-btn"
							onClick={() => setChannelViewMode("web")}
							className={`flex items-center gap-4 rounded-[var(--radius-xs)] px-8 py-2 tr-text-action transition-colors ${
								channelViewMode === "web"
									? "bg-control-primary-bg text-control-primary-text"
									: "text-text-muted hover:text-text-default"
							}`}
							title="Официальный веб-клиент"
						>
							<RiGlobalLine className="size-14" />
							<span className="hidden sm:inline">Веб-клиент</span>
						</button>
					</div>

					<button
						type="button"
						data-testid="proxy-ask-agent-btn"
						onClick={handleAskAgent}
						className="flex items-center gap-8 rounded-[var(--radius-sm)] bg-control-bg px-12 py-4 tr-text-action text-text-default transition-colors hover:bg-control-bg-hovered"
						title="Ask Agent about this service"
					>
						<RiSparkling2Line className="size-14 text-primary" />
						<span className="hidden sm:inline">Ask Agent</span>
					</button>

					{channelViewMode === "web" && (
						<>
							<button
								type="button"
								data-testid="proxy-reload-btn"
								onClick={handleReload}
								className="flex size-28 items-center justify-center rounded-[var(--radius-sm)] text-text-muted transition-colors hover:bg-control-bg-hovered hover:text-text-default"
								title="Reload Web Client"
							>
								<RiRefreshLine className="size-16" />
							</button>

							<button
								type="button"
								data-testid="proxy-external-btn"
								onClick={handleOpenExternal}
								className="flex items-center gap-8 rounded-[var(--radius-sm)] border border-border-default bg-control-bg px-12 py-4 tr-text-action text-text-muted transition-colors hover:bg-control-bg-hovered hover:text-text-default"
								title="Open in external companion window"
							>
								<RiExternalLinkLine className="size-14" />
								<span className="hidden sm:inline">Open in Window</span>
							</button>
						</>
					)}
				</div>
			</div>

			{channelViewMode === "messages" ? (
				<HubMessagesView initialProvider={tab as HubAccountProvider} />
			) : (
				<>
					{/* WhatsApp Linked Device QR Code Banner */}
					{tab === "whatsapp" && waAccount?.status !== "connected" && (
						<div
							data-testid="whatsapp-qr-banner"
							className="flex flex-col items-center justify-between gap-16 border-b border-border-default bg-container-header-bg p-16 sm:flex-row"
						>
							<div className="flex items-start gap-12">
								<RiWhatsappLine className="size-24 shrink-0 text-feedback-success" />
								<div>
									<div className="tr-title-compact text-text-default">
										Привязка автономного агента WhatsApp (Linked Device)
									</div>
									<div className="mt-4 tr-text-metadata text-text-muted">
										В центральной вкладке открыт веб-интерфейс для вашего просмотра. Чтобы{" "}
										<b>AI-ассистент</b> в правой панели мог читать переписку и помогать отвечать,
										привяжите устройство:{" "}
										<b>
											WhatsApp на телефоне → Настройки → Связанные устройства → Привязать устройство
										</b>
										.
									</div>
								</div>
							</div>
							{qrCodeDataUrl ? (
								<div className="flex flex-col items-center gap-8 shrink-0">
									<div className="rounded-[var(--radius-sm)] border border-border-default bg-container-elevated-bg p-4 shadow-xs">
										<img
											src={qrCodeDataUrl}
											alt="WhatsApp QR Code"
											className="size-48 sm:size-64"
										/>
									</div>
									<div className="flex items-center gap-8">
										<span className="tr-text-eyebrow text-text-muted">
											QR-код обновляется автоматически
										</span>
										<button
											type="button"
											onClick={() => {
												try {
													void getTransport().request("hub.syncNow", {
														accountId: "account_whatsapp",
														force: true,
													});
												} catch {}
											}}
											className="tr-text-action text-primary hover:underline"
										>
											Обновить QR
										</button>
									</div>
								</div>
							) : (
								<button
									type="button"
									onClick={() => {
										try {
											void getTransport().request("hub.syncNow", {
												accountId: "account_whatsapp",
												force: true,
											});
										} catch {}
									}}
									className="rounded-[var(--radius-sm)] bg-control-primary-bg px-12 py-8 tr-text-ui text-control-primary-text transition-colors hover:bg-control-primary-bg-hovered"
								>
									Сгенерировать QR-код для агента
								</button>
							)}
						</div>
					)}

					{/* Telegram Linked Device QR Code Banner */}
					{tab === "telegram" && tgAccount?.status !== "connected" && (
						<div
							data-testid="telegram-qr-banner"
							className="flex flex-col items-center justify-between gap-16 border-b border-border-default bg-container-header-bg p-16 sm:flex-row"
						>
							<div className="flex flex-1 items-start gap-12">
								<RiTelegramLine className="size-24 shrink-0 text-[#24A1DE]" />
								<div className="flex-1 min-w-0">
									<div className="tr-title-compact text-text-default">
										Привязка автономного агента Telegram (QR-код)
									</div>
									<div className="mt-4 tr-text-metadata text-text-muted">
										В центральной вкладке открыт веб-интерфейс для вашего просмотра. Чтобы{" "}
										<b>AI-ассистент</b> в правой панели мог читать переписку и помогать отвечать,
										привяжите устройство:{" "}
										<b>Telegram на телефоне → Настройки → Устройства → Подключить устройство</b>.
									</div>

									{/* 2FA Cloud Password Form */}
									{tgAccount?.metadata?.needs2fa || showTgPasswordInput ? (
										<div
											data-testid="telegram-2fa-container"
											className="mt-12 flex flex-col gap-8 rounded-[var(--radius-sm)] border border-border-default bg-container-elevated-bg p-12"
										>
											<div className="flex items-center gap-8 text-[#f59e0b] tr-text-ui">
												<RiLockLine className="size-16" />
												<span className="font-medium">Требуется облачный пароль (2FA)</span>
											</div>
											<div className="tr-text-metadata text-text-muted">
												На вашем аккаунте Telegram включена двухэтапная аутентификация. Введите
												облачный пароль для завершения привязки устройства.
												{tgAccount?.metadata?.passwordHint ? (
													<div className="mt-4 text-text-default">
														Подсказка: <b>{String(tgAccount.metadata.passwordHint)}</b>
													</div>
												) : null}
											</div>
											<form
												onSubmit={handleSubmitTgPassword}
												className="flex flex-col gap-8 sm:flex-row"
											>
												<input
													data-testid="telegram-2fa-input"
													type="password"
													value={tgPassword}
													onChange={(e) => setTgPassword(e.target.value)}
													placeholder="Введите облачный пароль Telegram..."
													disabled={isSubmittingTgPassword}
													className="flex-1 rounded-[var(--radius-sm)] border border-border-default bg-input-bg px-12 py-6 tr-text-ui text-text-default focus:border-primary focus:outline-hidden"
												/>
												<button
													data-testid="telegram-2fa-submit-btn"
													type="submit"
													disabled={!tgPassword.trim() || isSubmittingTgPassword}
													className="rounded-[var(--radius-sm)] bg-control-primary-bg px-12 py-6 tr-text-action text-control-primary-text transition-colors hover:bg-control-primary-bg-hovered disabled:opacity-50"
												>
													{isSubmittingTgPassword ? "Отправка..." : "Подтвердить пароль"}
												</button>
											</form>
											{tgPasswordFeedback ? (
												<div
													data-testid="telegram-2fa-feedback"
													className={`tr-text-metadata ${
														tgPasswordFeedback.isError
															? "text-feedback-error"
															: "text-feedback-success"
													}`}
												>
													{tgPasswordFeedback.text}
												</div>
											) : null}
											{tgAccount?.metadata?.error ? (
												<div className="tr-text-metadata text-feedback-error">
													{String(tgAccount.metadata.error)}
												</div>
											) : null}
										</div>
									) : (
										<div className="mt-8">
											<button
												type="button"
												data-testid="telegram-2fa-toggle-btn"
												onClick={() => setShowTgPasswordInput(true)}
												className="flex items-center gap-4 tr-text-action text-primary hover:underline"
											>
												<RiLockLine className="size-14" />
												Включена двухэтапная аутентификация (2FA)? Ввести облачный пароль
											</button>
										</div>
									)}
								</div>
							</div>
							{tgQrCodeDataUrl ? (
								<div className="flex flex-col items-center gap-8 shrink-0">
									<div className="rounded-[var(--radius-sm)] border border-border-default bg-container-elevated-bg p-4 shadow-xs">
										<img
											src={tgQrCodeDataUrl}
											alt="Telegram QR Code"
											className="size-48 sm:size-64"
										/>
									</div>
									<div className="flex items-center gap-8">
										<span className="tr-text-eyebrow text-text-muted">
											QR-код обновляется автоматически
										</span>
										<button
											type="button"
											onClick={() => {
												try {
													void getTransport().request("hub.syncNow", {
														accountId: "account_telegram",
														force: true,
													});
												} catch {}
											}}
											className="tr-text-action text-primary hover:underline"
										>
											Обновить QR
										</button>
									</div>
								</div>
							) : (
								<button
									type="button"
									onClick={() => {
										try {
											void getTransport().request("hub.syncNow", {
												accountId: "account_telegram",
												force: true,
											});
										} catch {}
									}}
									className="rounded-[var(--radius-sm)] bg-control-primary-bg px-12 py-8 tr-text-ui text-control-primary-text transition-colors hover:bg-control-primary-bg-hovered"
								>
									Сгенерировать QR-код для агента
								</button>
							)}
						</div>
					)}

					{/* Browser-mode helper banner for WhatsApp */}
					{!isDesktop && tab === "whatsapp" && (
						<div
							data-testid="whatsapp-browser-banner"
							className="flex items-center justify-between border-b border-border-default bg-container-header-bg px-16 py-8"
						>
							<div className="flex items-center gap-8 tr-text-metadata text-text-muted">
								<RiInformationLine className="size-16 shrink-0 text-primary" />
								<span>
									Браузерный iframe блокируется политиками WhatsApp. Для бесшовного встраивания
									используйте десктопное приложение или отдельное окно.
								</span>
							</div>
							<button
								type="button"
								data-testid="whatsapp-open-window-btn"
								onClick={handleOpenExternal}
								className="shrink-0 rounded-[var(--radius-sm)] bg-control-primary-bg px-12 py-4 tr-text-action text-control-primary-text transition-colors hover:bg-control-primary-bg-hovered"
							>
								Открыть в окне
							</button>
						</div>
					)}

					{/* Embedded Container: Native Webview in Desktop, Iframe / Discord Panel in Browser */}
					<div className="relative flex-1 min-h-0 min-w-0 bg-container-content-bg">
						{isDesktop ? (
							React.createElement("electrobun-webview", {
								key: reloadKey,
								"data-testid": "proxy-electrobun-webview",
								src: service.defaultUrl,
								partition: tab,
								className: "block h-full w-full border-none",
							})
						) : tab === "discord" ? (
							<DiscordHubPanel
								account={discordAccount}
								onOpenExternal={handleOpenExternal}
								onSwitchToMessages={() => setChannelViewMode("messages")}
							/>
						) : (
							<iframe
								key={reloadKey}
								data-testid="proxy-iframe"
								src={proxyUrl}
								title={service.name}
								tabIndex={-1}
								className="h-full w-full border-none"
								allow="camera; microphone; clipboard-read; clipboard-write; notifications; display-capture; autoplay; focus-without-user-activation 'none'"
							/>
						)}
					</div>
				</>
			)}
		</div>
	);
}

function DiscordHubPanel({
	account,
	onOpenExternal,
	onSwitchToMessages,
}: {
	account?: HubAccount | undefined;
	onOpenExternal: () => void;
	onSwitchToMessages: () => void;
}) {
	const isConnected = account?.status === "connected";
	const [activeSubTab, setActiveSubTab] = useState<"bot" | "package">("bot");

	// Bot form state
	const [token, setToken] = useState("");
	const [guildId, setGuildId] = useState("");
	const [channelIds, setChannelIds] = useState("");
	const [applicationId, setApplicationId] = useState("");
	const [isSaving, setIsSaving] = useState(false);
	const [isBackfilling, setIsBackfilling] = useState(false);
	const [saveError, setSaveError] = useState<string | null>(null);
	const [saveSuccess, setSaveSuccess] = useState<string | null>(null);
	const [showForm, setShowForm] = useState(!isConnected);
	const [showGuide, setShowGuide] = useState(false);

	// Data package import state
	const [packagePath, setPackagePath] = useState("");
	const [isImporting, setIsImporting] = useState(false);
	const [importError, setImportError] = useState<string | null>(null);
	const [importSuccess, setImportSuccess] = useState<string | null>(null);

	const handleSave = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!token.trim()) {
			setSaveError("Введите Bot Token Discord");
			return;
		}
		setIsSaving(true);
		setSaveError(null);
		setSaveSuccess(null);
		try {
			const configPayload: Record<string, unknown> = {
				botToken: token.trim(),
				enabled: true,
			};
			if (guildId.trim()) {
				configPayload.guildId = guildId.trim();
			}
			if (channelIds.trim()) {
				configPayload.channelIds = channelIds
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean);
			}

			const res = (await getTransport().request("hub.saveAccountConfig", {
				accountId: "account_discord",
				config: configPayload,
			})) as { success: boolean; error?: string };

			if (res.success) {
				setSaveSuccess("Настройки сохранены! Синхронизация Discord запущена.");
				const accRes = (await getTransport().request("hub.getAccounts", {})) as {
					accounts?: HubAccount[];
				};
				if (accRes?.accounts) {
					useAppStore.getState().setHubAccounts(accRes.accounts);
				}
				setShowForm(false);
			} else {
				setSaveError(res.error || "Не удалось сохранить настройки");
			}
		} catch (err: unknown) {
			setSaveError(err instanceof Error ? err.message : String(err));
		} finally {
			setIsSaving(false);
		}
	};

	const handleSyncNow = async () => {
		try {
			await getTransport().request("hub.syncNow", {
				accountId: "account_discord",
				force: true,
			});
			const accRes = (await getTransport().request("hub.getAccounts", {})) as {
				accounts?: HubAccount[];
			};
			if (accRes?.accounts) {
				useAppStore.getState().setHubAccounts(accRes.accounts);
			}
		} catch (err) {
			console.error("Sync failed", err);
		}
	};

	const handleBackfill = async () => {
		setIsBackfilling(true);
		setSaveSuccess(null);
		setSaveError(null);
		try {
			await getTransport().request("hub.syncNow", {
				accountId: "account_discord",
				force: true,
				backfill: true,
				backfillLimit: 500,
			});
			const accRes = (await getTransport().request("hub.getAccounts", {})) as {
				accounts?: HubAccount[];
			};
			if (accRes?.accounts) {
				useAppStore.getState().setHubAccounts(accRes.accounts);
			}
			setSaveSuccess("Глубокая загрузка истории каналов завершена!");
		} catch (err: unknown) {
			setSaveError(err instanceof Error ? err.message : String(err));
		} finally {
			setIsBackfilling(false);
		}
	};

	const handleImportPackage = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!packagePath.trim()) {
			setImportError("Укажите путь к архиву package.zip или распакованной папке");
			return;
		}
		setIsImporting(true);
		setImportError(null);
		setImportSuccess(null);
		try {
			const res = (await getTransport().request("hub.importDiscordPackage", {
				packagePath: packagePath.trim(),
				accountId: "account_discord",
			})) as {
				success: boolean;
				importedChannels?: number;
				importedMessages?: number;
				error?: string;
			};

			if (res.success) {
				setImportSuccess(
					`Успешно импортировано: ${res.importedChannels ?? 0} каналов, ${res.importedMessages ?? 0} сообщений! База обновлена.`,
				);
				const accRes = (await getTransport().request("hub.getAccounts", {})) as {
					accounts?: HubAccount[];
				};
				if (accRes?.accounts) {
					useAppStore.getState().setHubAccounts(accRes.accounts);
				}
			} else {
				setImportError(res.error || "Не удалось импортировать архив");
			}
		} catch (err: unknown) {
			setImportError(err instanceof Error ? err.message : String(err));
		} finally {
			setIsImporting(false);
		}
	};

	const inviteUrl = applicationId.trim()
		? `https://discord.com/oauth2/authorize?client_id=${applicationId.trim()}&scope=bot&permissions=66560`
		: "";

	return (
		<div
			data-testid="discord-hub-panel"
			className="flex h-full flex-col items-center justify-start overflow-y-auto p-24"
		>
			<div className="w-full max-w-2xl space-y-16">
				{/* Header Card */}
				<div className="rounded-[var(--radius-md)] border border-border-default bg-container-header-bg p-20 shadow-xs">
					<div className="flex items-start gap-16">
						<div className="rounded-[var(--radius-sm)] bg-[#5865F2]/10 p-12 text-[#5865F2]">
							<RiDiscordLine className="size-32" />
						</div>
						<div className="flex-1 min-w-0">
							<div className="flex items-center gap-8">
								<h2 className="tr-title-compact text-text-default">Центр управления Discord</h2>
								{isConnected ? (
									<span className="inline-flex items-center gap-4 rounded-full bg-feedback-success-subtle px-8 py-2 tr-text-eyebrow text-feedback-success">
										<RiShieldCheckLine className="size-12" />
										Подключен
									</span>
								) : (
									<span className="inline-flex items-center gap-4 rounded-full bg-feedback-warning-subtle px-8 py-2 tr-text-eyebrow text-feedback-warning">
										<RiAlertLine className="size-12" />
										Не подключен
									</span>
								)}
							</div>
							<p className="mt-8 tr-text-metadata text-text-muted">
								Веб-клиент Discord блокирует браузерные iframe политикой безопасности. Для чтения
								каналов, поиска AI-ассистентом и уведомлений вы можете настроить автоматическую
								синхронизацию через безопасного Discord-бота или импортировать официальный архив
								ваших данных.
							</p>

							<div className="mt-16 flex flex-wrap items-center gap-8">
								<button
									type="button"
									data-testid="discord-open-external-btn"
									onClick={onOpenExternal}
									className="flex items-center gap-8 rounded-[var(--radius-sm)] bg-control-primary-bg px-12 py-8 tr-text-action text-control-primary-text transition-colors hover:bg-control-primary-bg-hovered"
								>
									<RiExternalLinkLine className="size-16" />
									<span>Открыть Discord в окне</span>
								</button>
								<button
									type="button"
									data-testid="discord-view-db-messages-btn"
									onClick={onSwitchToMessages}
									className="flex items-center gap-8 rounded-[var(--radius-sm)] bg-control-bg px-12 py-8 tr-text-action text-text-default transition-colors hover:bg-control-bg-hovered"
								>
									<RiChat1Line className="size-16" />
									<span>Показать сообщения (БД)</span>
								</button>
							</div>
						</div>
					</div>
				</div>

				{/* Tabs Selector: Bot vs Data Package */}
				<div className="flex rounded-[var(--radius-sm)] border border-border-default bg-container-header-bg p-4">
					<button
						type="button"
						onClick={() => setActiveSubTab("bot")}
						className={`flex flex-1 items-center justify-center gap-8 rounded-[var(--radius-sm)] py-8 tr-text-action transition-colors ${
							activeSubTab === "bot"
								? "bg-control-primary-bg text-control-primary-text shadow-xs"
								: "text-text-muted hover:text-text-default"
						}`}
					>
						<RiRobotLine className="size-16" />
						<span>Discord Bot (Автоматический сбор)</span>
					</button>
					<button
						type="button"
						onClick={() => setActiveSubTab("package")}
						className={`flex flex-1 items-center justify-center gap-8 rounded-[var(--radius-sm)] py-8 tr-text-action transition-colors ${
							activeSubTab === "package"
								? "bg-control-primary-bg text-control-primary-text shadow-xs"
								: "text-text-muted hover:text-text-default"
						}`}
					>
						<RiDownloadCloud2Line className="size-16" />
						<span>Импорт Data Package (Архив аккаунта)</span>
					</button>
				</div>

				{/* SUBTAB 1: Discord Bot */}
				{activeSubTab === "bot" && (
					<div className="rounded-[var(--radius-md)] border border-border-default bg-container-header-bg p-20 shadow-xs space-y-16">
						<div className="flex items-center justify-between border-b border-border-default pb-12">
							<div className="flex items-center gap-8">
								<RiRobotLine className="size-18 text-primary" />
								<h3 className="tr-title-compact text-text-default">
									Синхронизация через Discord Bot
								</h3>
							</div>
							<button
								type="button"
								onClick={() => setShowGuide((prev) => !prev)}
								className="tr-text-action text-primary hover:underline"
							>
								{showGuide ? "Скрыть инструкцию" : "Как настроить бота?"}
							</button>
						</div>

						{/* Step-by-Step Guide */}
						{showGuide && (
							<div className="rounded-[var(--radius-sm)] border border-primary/20 bg-primary/5 p-16 space-y-12">
								<h4 className="tr-title-compact text-text-default flex items-center gap-8">
									<RiInformationLine className="size-16 text-primary" />
									Быстрая настройка официального Discord-бота
								</h4>
								<ol className="list-decimal list-inside space-y-8 tr-text-metadata text-text-muted">
									<li>
										Перейдите в{" "}
										<a
											href="https://discord.com/developers/applications"
											target="_blank"
											rel="noreferrer"
											className="text-primary hover:underline font-medium inline-flex items-center gap-2"
										>
											Discord Developer Portal
											<RiExternalLinkLine className="size-12" />
										</a>{" "}
										и нажмите <strong>«New Application»</strong> (например, ThinkRailBot).
									</li>
									<li>
										Откройте вкладку <strong>«Bot»</strong> слева, нажмите{" "}
										<strong>«Reset Token»</strong> и скопируйте полученный токен.
									</li>
									<li>
										В этой же вкладке «Bot» в разделе <strong>Privileged Gateway Intents</strong>{" "}
										включите галочку <strong>«Message Content Intent»</strong> (необходимо для
										чтения текста сообщений).
									</li>
									<li>
										Добавьте бота на свой сервер (введите Application ID ниже для быстрой ссылки с
										правами <code>View Channel</code> и <code>Read Message History</code>).
									</li>
									<li>Вставьте токен в форму ниже и нажмите «Сохранить и подключить».</li>
								</ol>

								{/* Helper: Bot Invite Link Generator */}
								<div className="mt-12 pt-12 border-t border-border-default">
									<label
										htmlFor="discord-appid-input"
										className="block tr-text-ui text-text-default mb-4"
									>
										Application ID / Client ID (для создания ссылки добавления бота):
									</label>
									<div className="flex gap-8">
										<input
											id="discord-appid-input"
											type="text"
											value={applicationId}
											onChange={(e) => setApplicationId(e.target.value)}
											placeholder="Например: 123456789012345678"
											className="flex-1 rounded-[var(--radius-sm)] border border-border-default bg-container-content-bg px-12 py-6 tr-text-metadata text-text-default placeholder:text-text-muted focus:border-primary focus:outline-none"
										/>
										{inviteUrl ? (
											<a
												href={inviteUrl}
												target="_blank"
												rel="noreferrer"
												className="rounded-[var(--radius-sm)] bg-control-primary-bg px-12 py-6 tr-text-action text-control-primary-text hover:bg-control-primary-bg-hovered transition-colors inline-flex items-center gap-4"
											>
												<RiExternalLinkLine className="size-14" />
												<span>Пригласить на сервер</span>
											</a>
										) : null}
									</div>
								</div>
							</div>
						)}

						{isConnected && !showForm ? (
							<div className="space-y-12">
								<div className="flex items-center justify-between rounded-[var(--radius-sm)] border border-feedback-success/30 bg-feedback-success-subtle p-12">
									<div className="flex items-center gap-8">
										<RiShieldCheckLine className="size-18 text-feedback-success" />
										<div>
											<div className="tr-text-ui text-text-default">
												Бот: <strong>{account?.name || "Discord Bot"}</strong>
											</div>
											<div className="tr-text-eyebrow text-text-muted">
												{account?.metadata?.username
													? `@${account.metadata.username}`
													: "Синхронизация активна (Gateway + REST)"}
											</div>
										</div>
									</div>
									<div className="flex items-center gap-8">
										<button
											type="button"
											data-testid="discord-sync-now-btn"
											onClick={handleSyncNow}
											className="flex items-center gap-4 rounded-[var(--radius-sm)] bg-control-bg px-12 py-6 tr-text-action text-text-default hover:bg-control-bg-hovered"
										>
											<RiRefreshLine className="size-14" />
											<span>Синхронизировать</span>
										</button>
										<button
											type="button"
											onClick={handleBackfill}
											disabled={isBackfilling}
											className="flex items-center gap-4 rounded-[var(--radius-sm)] bg-control-primary-bg px-12 py-6 tr-text-action text-control-primary-text hover:bg-control-primary-bg-hovered disabled:opacity-50"
										>
											<RiHistoryLine className="size-14" />
											<span>{isBackfilling ? "Загрузка..." : "Вся история (Backfill)"}</span>
										</button>
									</div>
								</div>
								{saveSuccess && (
									<div className="rounded-[var(--radius-sm)] border border-feedback-success/30 bg-feedback-success-subtle p-8 tr-text-metadata text-feedback-success">
										{saveSuccess}
									</div>
								)}
								<div className="flex items-center justify-between pt-8">
									<p className="tr-text-metadata text-text-muted">
										Сообщения сохраняются в локальную SQLite с FTS5 и доступны AI-ассистенту.
									</p>
									<button
										type="button"
										onClick={() => setShowForm(true)}
										className="tr-text-action text-primary hover:underline"
									>
										Изменить параметры
									</button>
								</div>
							</div>
						) : (
							<form onSubmit={handleSave} className="space-y-12">
								{saveError && (
									<div className="rounded-[var(--radius-sm)] border border-feedback-error/30 bg-feedback-error-subtle p-8 tr-text-metadata text-feedback-error">
										{saveError}
									</div>
								)}
								{saveSuccess && (
									<div className="rounded-[var(--radius-sm)] border border-feedback-success/30 bg-feedback-success-subtle p-8 tr-text-metadata text-feedback-success">
										{saveSuccess}
									</div>
								)}
								{account?.error && !saveError && (
									<div className="rounded-[var(--radius-sm)] border border-feedback-warning/30 bg-feedback-warning-subtle p-8 tr-text-metadata text-feedback-warning">
										{account.error}
									</div>
								)}

								<div>
									<label
										htmlFor="discord-token-input"
										className="block tr-text-ui text-text-default mb-4"
									>
										Discord Bot Token
									</label>
									<input
										id="discord-token-input"
										type="password"
										value={token}
										onChange={(e) => setToken(e.target.value)}
										placeholder="Вставьте токен вашего Discord-бота"
										className="w-full rounded-[var(--radius-sm)] border border-border-default bg-container-content-bg px-12 py-8 tr-text-metadata text-text-default placeholder:text-text-muted focus:border-primary focus:outline-none"
									/>
									<span className="mt-4 block tr-text-eyebrow text-text-muted">
										Токен сохраняется исключительно в локальном файле
										`~/.thinkrail/hub-accounts.json` на вашем компьютере.
									</span>
								</div>

								<div>
									<label
										htmlFor="discord-guild-input"
										className="block tr-text-ui text-text-default mb-4"
									>
										ID сервера / Guild ID (необязательно, если оставить пустым — со всех серверов)
									</label>
									<input
										id="discord-guild-input"
										type="text"
										value={guildId}
										onChange={(e) => setGuildId(e.target.value)}
										placeholder="Например: 123456789012345678"
										className="w-full rounded-[var(--radius-sm)] border border-border-default bg-container-content-bg px-12 py-8 tr-text-metadata text-text-default placeholder:text-text-muted focus:border-primary focus:outline-none"
									/>
								</div>

								<div>
									<label
										htmlFor="discord-channels-input"
										className="block tr-text-ui text-text-default mb-4"
									>
										ID каналов через запятую (необязательно, если оставить пустым — со всех каналов)
									</label>
									<input
										id="discord-channels-input"
										type="text"
										value={channelIds}
										onChange={(e) => setChannelIds(e.target.value)}
										placeholder="Например: 987654321, 123456789"
										className="w-full rounded-[var(--radius-sm)] border border-border-default bg-container-content-bg px-12 py-8 tr-text-metadata text-text-default placeholder:text-text-muted focus:border-primary focus:outline-none"
									/>
								</div>

								<div className="flex items-center justify-end gap-8 pt-8">
									{isConnected && (
										<button
											type="button"
											onClick={() => setShowForm(false)}
											className="rounded-[var(--radius-sm)] bg-control-bg px-12 py-6 tr-text-action text-text-default hover:bg-control-bg-hovered"
										>
											Отмена
										</button>
									)}
									<button
										type="submit"
										disabled={isSaving}
										className="flex items-center gap-4 rounded-[var(--radius-sm)] bg-control-primary-bg px-16 py-8 tr-text-action text-control-primary-text hover:bg-control-primary-bg-hovered disabled:opacity-50"
									>
										{isSaving ? "Подключение..." : "Сохранить и подключить"}
									</button>
								</div>
							</form>
						)}
					</div>
				)}

				{/* SUBTAB 2: Data Package Import */}
				{activeSubTab === "package" && (
					<div className="rounded-[var(--radius-md)] border border-border-default bg-container-header-bg p-20 shadow-xs space-y-16">
						<div className="flex items-center gap-8 border-b border-border-default pb-12">
							<RiDownloadCloud2Line className="size-18 text-primary" />
							<h3 className="tr-title-compact text-text-default">
								Импорт официального архива Discord Data Package
							</h3>
						</div>

						<p className="tr-text-metadata text-text-muted">
							Если вы хотите сохранить историю личных сообщений (DMs), отправленных сообщений и
							старых каналов без использования бота, запросите архив данных в клиенте Discord:
						</p>

						<div className="rounded-[var(--radius-sm)] border border-border-default bg-container-content-bg p-12 tr-text-metadata text-text-muted space-y-4">
							<div>
								1. В Discord откройте:{" "}
								<strong>Настройки пользователя → Конфиденциальность (Data & Privacy)</strong>
							</div>
							<div>
								2. Нажмите кнопку{" "}
								<strong>«Запросить все мои данные» (Request all of my Data)</strong>
							</div>
							<div>
								3. Когда архив будет готов, скачайте файл <code>package.zip</code>
							</div>
						</div>

						<form onSubmit={handleImportPackage} className="space-y-12">
							{importError && (
								<div className="rounded-[var(--radius-sm)] border border-feedback-error/30 bg-feedback-error-subtle p-8 tr-text-metadata text-feedback-error">
									{importError}
								</div>
							)}
							{importSuccess && (
								<div className="rounded-[var(--radius-sm)] border border-feedback-success/30 bg-feedback-success-subtle p-8 tr-text-metadata text-feedback-success">
									{importSuccess}
								</div>
							)}

							<div>
								<label
									htmlFor="discord-package-path"
									className="block tr-text-ui text-text-default mb-4"
								>
									Путь к файлу package.zip или распакованной папке:
								</label>
								<input
									id="discord-package-path"
									type="text"
									value={packagePath}
									onChange={(e) => setPackagePath(e.target.value)}
									placeholder="/Users/username/Downloads/package.zip"
									className="w-full rounded-[var(--radius-sm)] border border-border-default bg-container-content-bg px-12 py-8 tr-text-metadata text-text-default placeholder:text-text-muted focus:border-primary focus:outline-none"
								/>
								<span className="mt-4 block tr-text-eyebrow text-text-muted">
									Вы также можете запустить импорт через CLI:{" "}
									<code>bun run import:discord-package &lt;путь&gt;</code>
								</span>
							</div>

							<div className="flex items-center justify-end gap-8 pt-8">
								<button
									type="submit"
									disabled={isImporting}
									className="flex items-center gap-6 rounded-[var(--radius-sm)] bg-control-primary-bg px-16 py-8 tr-text-action text-control-primary-text hover:bg-control-primary-bg-hovered disabled:opacity-50"
								>
									<RiDownloadCloud2Line className="size-16" />
									<span>{isImporting ? "Импортирование..." : "Импортировать в базу данных"}</span>
								</button>
							</div>
						</form>
					</div>
				)}
			</div>
		</div>
	);
}
