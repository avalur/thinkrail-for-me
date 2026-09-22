import {
	type RemixiconComponentType,
	RiChat1Line,
	RiDiscordLine,
	RiExternalLinkLine,
	RiGlobalLine,
	RiInformationLine,
	RiMailLine,
	RiQrCodeLine,
	RiRefreshLine,
	RiShieldCheckLine,
	RiSlackLine,
	RiSparkling2Line,
	RiTelegramLine,
	RiWhatsappLine,
} from "@remixicon/react";
import type { HubAccountProvider } from "@thinkrail/contracts";
import React, { useState } from "react";
import { useAppStore } from "../store";
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
		defaultUrl: "https://web.telegram.org/a/",
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
	const proxyUrl = tab === "discord" ? "/proxy/discord/channels/@me" : `/proxy/${tab}`;
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
	const qrCodeDataUrl = waAccount?.metadata?.qrCodeDataUrl as string | undefined;
	const channelViewMode = useAppStore((s) => s.hubViewPreference[tab] ?? "web");
	const setChannelViewMode = (pref: "messages" | "web") => {
		useAppStore.getState().setHubViewPreference(tab, pref);
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

					{/* Browser-mode helper banner for Discord */}
					{!isDesktop && tab === "discord" && (
						<div
							data-testid="discord-browser-banner"
							className="flex items-center justify-between border-b border-border-default bg-container-header-bg px-16 py-8"
						>
							<div className="flex items-center gap-8 tr-text-metadata text-text-muted">
								<RiInformationLine className="size-16 shrink-0 text-primary" />
								<span>
									Веб-клиент Discord открыт через локальный шлюз. Если авторизация в браузере
									требует отдельного окна, используйте «Открыть в окне».
								</span>
							</div>
							<button
								type="button"
								data-testid="discord-open-window-btn"
								onClick={handleOpenExternal}
								className="shrink-0 rounded-[var(--radius-sm)] bg-control-primary-bg px-12 py-4 tr-text-action text-control-primary-text transition-colors hover:bg-control-primary-bg-hovered"
							>
								Открыть в окне
							</button>
						</div>
					)}

					{/* Embedded Container: Native Webview in Desktop, Iframe in Browser */}
					<div className="relative flex-1 min-h-0 min-w-0 bg-container-content-bg">
						{isDesktop ? (
							React.createElement("electrobun-webview", {
								key: reloadKey,
								"data-testid": "proxy-electrobun-webview",
								src: service.defaultUrl,
								partition: tab,
								className: "block h-full w-full border-none",
							})
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
