import {
	type RemixiconComponentType,
	RiDiscordLine,
	RiExternalLinkLine,
	RiMailLine,
	RiRefreshLine,
	RiShieldCheckLine,
	RiSlackLine,
	RiSparkling2Line,
	RiTelegramLine,
	RiWhatsappLine,
} from "@remixicon/react";
import { useState } from "react";
import { useAppStore } from "../store";

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

export function ProxyEmbedView({ tab }: { tab: string }) {
	const [reloadKey, setReloadKey] = useState(0);
	const service = SERVICES[tab] ?? {
		name: tab.charAt(0).toUpperCase() + tab.slice(1),
		description: `Embedded view for ${tab}`,
		defaultUrl: `/proxy/${tab}`,
		icon: RiTelegramLine,
	};
	const Icon = service.icon;
	const proxyUrl = `/proxy/${tab}`;

	const handleReload = () => {
		setReloadKey((prev) => prev + 1);
	};

	const handleOpenExternal = () => {
		window.open(proxyUrl, "_blank", "noopener,noreferrer");
	};

	const handleAskAgent = () => {
		useAppStore.getState().setHubAssistantSidebarOpen(true);
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
						Proxy Active
					</span>
					<span className="hidden tr-text-metadata text-text-muted md:inline">
						{service.description}
					</span>
				</div>

				<div className="flex items-center gap-8">
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
						title="Open in external browser window"
					>
						<RiExternalLinkLine className="size-14" />
						<span className="hidden sm:inline">Open in Window</span>
					</button>
				</div>
			</div>

			{/* Embedded Iframe Container */}
			<div className="relative flex-1 min-h-0 min-w-0 bg-container-content-bg">
				<iframe
					key={reloadKey}
					data-testid="proxy-iframe"
					src={proxyUrl}
					title={service.name}
					className="h-full w-full border-none"
					sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals"
					allow="camera; microphone; clipboard-read; clipboard-write; notifications"
				/>
			</div>
		</div>
	);
}
