import {
	type RemixiconComponentType,
	RiAlertLine,
	RiArrowLeftLine,
	RiCheckDoubleLine,
	RiCheckLine,
	RiDiscordLine,
	RiFilterLine,
	RiGroupLine,
	RiMailLine,
	RiRefreshLine,
	RiSearchLine,
	RiSendPlaneFill,
	RiSlackLine,
	RiSparkling2Line,
	RiTelegramLine,
	RiUser3Line,
	RiWhatsappLine,
} from "@remixicon/react";
import type { HubAccountProvider, HubChannel, HubMessage } from "@thinkrail/contracts";
import { useEffect, useMemo, useState } from "react";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "../components/ui/resizable";
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

const PROVIDER_NAMES: Record<HubAccountProvider, string> = {
	telegram: "Telegram",
	email_work: "Work Email",
	email_personal: "Personal Email",
	slack: "Slack",
	discord: "Discord",
	whatsapp: "WhatsApp",
};

export interface HubMessagesViewProps {
	initialProvider?: HubAccountProvider;
	initialChannelId?: string;
	initialUnreadOnly?: boolean;
}

export function HubMessagesView({
	initialProvider,
	initialChannelId,
	initialUnreadOnly,
}: HubMessagesViewProps) {
	const accounts = useAppStore((s) => s.hubAccounts);
	const hubFilter = useAppStore((s) => s.hubFilter);

	const [selectedProvider, setSelectedProvider] = useState<HubAccountProvider | "all">(
		initialProvider ?? hubFilter.provider ?? "all",
	);
	const [unreadOnly, setUnreadOnly] = useState<boolean>(
		initialUnreadOnly ?? hubFilter.unreadOnly ?? false,
	);
	const [selectedChannelId, setSelectedChannelId] = useState<string | null>(
		initialChannelId ?? hubFilter.channelId ?? null,
	);
	const [searchQuery, setSearchQuery] = useState<string>(hubFilter.query ?? "");
	const [channels, setChannels] = useState<HubChannel[]>([]);
	const [messages, setMessages] = useState<HubMessage[]>([]);
	const [loading, setLoading] = useState(false);
	const [replyText, setReplyText] = useState("");
	const [sending, setSending] = useState(false);

	// Load channels
	const loadChannels = async () => {
		try {
			const res = (await getTransport().request("hub.getChannels", {})) as {
				channels?: HubChannel[];
			};
			if (res?.channels) {
				setChannels(res.channels);
			}
		} catch {
			// ignore fallback
		}
	};

	// Load messages
	const loadMessages = async () => {
		setLoading(true);
		try {
			const filter: Record<string, unknown> = {
				limit: 100,
			};
			if (selectedProvider !== "all") {
				filter.provider = selectedProvider;
			}
			if (selectedChannelId) {
				filter.channelId = selectedChannelId;
			}
			if (unreadOnly) {
				filter.isRead = false;
			}
			if (searchQuery.trim()) {
				filter.query = searchQuery.trim();
			}

			const res = (await getTransport().request("hub.getMessages", filter)) as {
				messages?: HubMessage[];
			};
			if (res?.messages) {
				setMessages(res.messages);
			}
		} catch {
			// fallback
		} finally {
			setLoading(false);
		}
	};

	useEffect(() => {
		void loadChannels();
	}, []);

	useEffect(() => {
		void loadMessages();
	}, [selectedProvider, selectedChannelId, unreadOnly, searchQuery]);

	// Sync local filters with store
	useEffect(() => {
		if (initialProvider && initialProvider !== selectedProvider) {
			setSelectedProvider(initialProvider);
		}
	}, [initialProvider]);

	useEffect(() => {
		if (initialUnreadOnly !== undefined && initialUnreadOnly !== unreadOnly) {
			setUnreadOnly(initialUnreadOnly);
		}
	}, [initialUnreadOnly]);

	const filteredChannels = useMemo(() => {
		return channels.filter((c) => {
			if (selectedProvider !== "all") {
				const acc = accounts.find((a) => a.id === c.accountId);
				if (acc && acc.provider !== selectedProvider) return false;
			}
			if (unreadOnly && c.unreadCount === 0) return false;
			if (searchQuery.trim()) {
				const q = searchQuery.toLowerCase();
				return c.name.toLowerCase().includes(q) || c.remoteId.toLowerCase().includes(q);
			}
			return true;
		});
	}, [channels, accounts, selectedProvider, unreadOnly, searchQuery]);

	const selectedChannel = useMemo(() => {
		return channels.find((c) => c.id === selectedChannelId);
	}, [channels, selectedChannelId]);

	const handleMarkAllRead = async () => {
		try {
			const params: Record<string, unknown> = { all: true };
			if (selectedChannelId) {
				params.channelId = selectedChannelId;
			} else if (selectedProvider !== "all") {
				params.provider = selectedProvider;
			}
			await getTransport().request("hub.markRead", params);
			void loadMessages();
			void loadChannels();
			const accRes = await getTransport().request("hub.getAccounts", {});
			if (accRes?.accounts) useAppStore.getState().setHubAccounts(accRes.accounts);
			const dash = await getTransport().request("hub.getDashboardSummary", {});
			if (dash) useAppStore.getState().setHubDashboard(dash);
		} catch (err) {
			console.error("Failed to mark messages read", err);
		}
	};

	const handleMarkMessageRead = async (messageId: string) => {
		try {
			await getTransport().request("hub.markRead", { messageIds: [messageId] });
			setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, isRead: true } : m)));
			void loadChannels();
			const accRes = await getTransport().request("hub.getAccounts", {});
			if (accRes?.accounts) useAppStore.getState().setHubAccounts(accRes.accounts);
			const dash = await getTransport().request("hub.getDashboardSummary", {});
			if (dash) useAppStore.getState().setHubDashboard(dash);
		} catch (err) {
			console.error("Failed to mark message read", err);
		}
	};

	const handleAskAgent = (msg?: HubMessage) => {
		useAppStore.getState().setHubAssistantSidebarOpen(true);
		const prompt = msg
			? `Помоги с сообщением от ${msg.senderName} (${msg.senderAddress}) в ${msg.subject || selectedChannel?.name || "чате"}: "${msg.snippet}"`
			: selectedChannel
				? `Сделай краткое саммари последних сообщений из "${selectedChannel.name}"`
				: "Помоги разобрать входящие сообщения";
		window.dispatchEvent(new CustomEvent("thinkrail:hub-prompt", { detail: { prompt } }));
	};

	const handleSendMessage = async () => {
		if (!replyText.trim()) return;
		setSending(true);
		try {
			const targetAccount =
				accounts.find((a) =>
					selectedProvider !== "all" ? a.provider === selectedProvider : a.status === "connected",
				) || accounts[0];
			if (!targetAccount) return;

			const recipient =
				selectedChannel?.remoteId ||
				messages[0]?.recipientAddress ||
				messages[0]?.senderAddress ||
				"";

			await getTransport().request("hub.sendMessage", {
				accountId: targetAccount.id,
				recipient,
				body: replyText.trim(),
				...(selectedChannelId ? { channelId: selectedChannelId } : {}),
			});
			setReplyText("");
			void loadMessages();
		} catch (err) {
			console.error("Failed to send message", err);
		} finally {
			setSending(false);
		}
	};

	const formatTimestamp = (ts: number): string => {
		const d = new Date(ts);
		const now = new Date();
		if (d.toDateString() === now.toDateString()) {
			return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
		}
		return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
	};

	return (
		<div
			data-testid="hub-messages-view"
			className="flex h-full min-h-0 flex-1 flex-col overflow-hidden bg-container-content-bg"
		>
			{/* Top Filter and Actions Bar */}
			<div
				data-testid="hub-messages-top-bar"
				className="flex flex-wrap items-center justify-between gap-12 border-b border-border-default bg-container-header-bg px-16 py-8"
			>
				<div className="flex flex-wrap items-center gap-8">
					{/* Provider pills */}
					<button
						type="button"
						onClick={() => {
							setSelectedProvider("all");
							setSelectedChannelId(null);
						}}
						className={`rounded-full px-12 py-4 tr-text-action transition-colors ${
							selectedProvider === "all"
								? "bg-control-primary-bg text-control-primary-text"
								: "bg-control-bg text-text-muted hover:bg-control-bg-hovered hover:text-text-default"
						}`}
					>
						Все каналы
					</button>
					{(
						[
							"whatsapp",
							"telegram",
							"email_work",
							"email_personal",
							"slack",
							"discord",
						] as HubAccountProvider[]
					).map((p) => {
						const Icon = PROVIDER_ICONS[p];
						const isSel = selectedProvider === p;
						return (
							<button
								key={p}
								type="button"
								onClick={() => {
									setSelectedProvider(p);
									setSelectedChannelId(null);
								}}
								className={`flex items-center gap-8 rounded-full px-12 py-4 tr-text-action transition-colors ${
									isSel
										? "bg-control-primary-bg text-control-primary-text"
										: "bg-control-bg text-text-muted hover:bg-control-bg-hovered hover:text-text-default"
								}`}
							>
								<Icon className="size-14" />
								<span>{PROVIDER_NAMES[p]}</span>
							</button>
						);
					})}
				</div>

				<div className="flex items-center gap-8">
					{/* Toggle unread only */}
					<button
						type="button"
						data-testid="toggle-unread-only-btn"
						onClick={() => setUnreadOnly((prev) => !prev)}
						className={`flex items-center gap-8 rounded-[var(--radius-sm)] border px-12 py-4 tr-text-action transition-colors ${
							unreadOnly
								? "border-feedback-info bg-feedback-info-subtle text-feedback-info"
								: "border-border-default bg-control-bg text-text-muted hover:bg-control-bg-hovered hover:text-text-default"
						}`}
					>
						<RiFilterLine className="size-14" />
						<span>{unreadOnly ? "Только непрочитанные" : "Все сообщения"}</span>
					</button>

					{/* Mark all read button */}
					<button
						type="button"
						data-testid="mark-all-read-btn"
						onClick={handleMarkAllRead}
						className="flex items-center gap-8 rounded-[var(--radius-sm)] border border-border-default bg-control-bg px-12 py-4 tr-text-action text-text-muted transition-colors hover:bg-control-bg-hovered hover:text-text-default"
						title="Отметить все прочитанными"
					>
						<RiCheckDoubleLine className="size-14" />
						<span className="hidden sm:inline">Отметить всё прочитанным</span>
					</button>

					{/* Reload button */}
					<button
						type="button"
						onClick={() => {
							void loadMessages();
							void loadChannels();
						}}
						className="flex size-28 items-center justify-center rounded-[var(--radius-sm)] text-text-muted transition-colors hover:bg-control-bg-hovered hover:text-text-default"
						title="Обновить"
					>
						<RiRefreshLine className="size-16" />
					</button>
				</div>
			</div>

			{/* Main Content: Split Master-Detail */}
			<ResizablePanelGroup
				direction="horizontal"
				autoSaveId="thinkrail-hub-messages-split"
				className="min-h-0 flex-1 overflow-hidden"
			>
				{/* Left Sidebar: Channels & Chats */}
				<ResizablePanel
					id="hub-channels-sidebar-panel"
					order={1}
					defaultSize={28}
					minSize={16}
					maxSize={50}
					className="flex min-h-0 flex-col bg-container-header-bg"
				>
					<div
						data-testid="hub-channels-sidebar"
						className="flex h-full min-h-0 w-full flex-col overflow-hidden"
					>
						{/* Search input */}
						<div className="border-b border-border-default p-8">
							<div className="relative flex items-center">
								<RiSearchLine className="absolute left-8 size-14 text-text-muted" />
								<input
									type="text"
									value={searchQuery}
									onChange={(e) => setSearchQuery(e.target.value)}
									placeholder="Поиск по чатам и сообщениям..."
									className="w-full rounded-[var(--radius-sm)] border border-border-default bg-control-bg py-4 pl-24 pr-8 tr-text-ui text-text-default placeholder:text-text-muted focus:border-primary focus:outline-none"
								/>
							</div>
						</div>

						{/* Channel list */}
						<div className="flex-1 overflow-y-auto p-4 space-y-2">
							{/* "All Messages" item */}
							<button
								type="button"
								onClick={() => setSelectedChannelId(null)}
								className={`flex w-full items-center justify-between rounded-[var(--radius-sm)] p-8 text-left transition-colors ${
									selectedChannelId === null
										? "bg-control-bg-selected text-text-default"
										: "text-text-muted hover:bg-control-bg-hovered hover:text-text-default"
								}`}
							>
								<div className="flex items-center gap-8 truncate">
									<RiUser3Line className="size-16 shrink-0 text-primary" />
									<span className="truncate tr-text-ui">Все чаты и отправители</span>
								</div>
							</button>

							{filteredChannels.map((ch) => {
								const isSel = selectedChannelId === ch.id;
								const isGroup = ch.kind === "group" || ch.remoteId.endsWith("@g.us");
								return (
									<button
										key={ch.id}
										type="button"
										data-testid={`channel-item-${ch.id}`}
										onClick={() => setSelectedChannelId(ch.id)}
										className={`flex w-full items-center justify-between rounded-[var(--radius-sm)] p-8 text-left transition-colors ${
											isSel
												? "bg-control-bg-selected text-text-default shadow-xs"
												: "text-text-muted hover:bg-control-bg-hovered hover:text-text-default"
										}`}
									>
										<div className="flex items-center gap-8 min-w-0 pr-8">
											{isGroup ? (
												<RiGroupLine className="size-16 shrink-0 text-feedback-info" />
											) : (
												<RiUser3Line className="size-16 shrink-0 text-text-muted" />
											)}
											<div className="truncate">
												<div className="truncate tr-text-ui text-text-default">
													{ch.name || ch.remoteId}
												</div>
												<div className="truncate tr-text-eyebrow text-text-muted">
													{ch.remoteId}
												</div>
											</div>
										</div>

										{ch.unreadCount > 0 && (
											<span className="shrink-0 rounded-full bg-feedback-info-subtle px-8 py-2 tr-text-eyebrow text-feedback-info">
												{ch.unreadCount > 99 ? "99+" : ch.unreadCount}
											</span>
										)}
									</button>
								);
							})}

							{filteredChannels.length === 0 && (
								<div className="p-16 text-center tr-text-metadata text-text-muted">
									Чаты не найдены
								</div>
							)}
						</div>
					</div>
				</ResizablePanel>

				<ResizableHandle
					direction="horizontal"
					data-testid="hub-messages-resize-handle"
					withHandle
				/>

				{/* Right Panel: Messages Stream */}
				<ResizablePanel
					id="hub-messages-stream-panel"
					order={2}
					defaultSize={72}
					minSize={40}
					className="flex min-h-0 flex-1 flex-col overflow-hidden bg-container-content-bg"
				>
					<div
						data-testid="hub-messages-stream-pane"
						className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-container-content-bg"
					>
						{/* Stream Header */}
						<div className="flex h-44 shrink-0 items-center justify-between border-b border-border-default bg-container-header-bg px-16">
							<div className="flex items-center gap-8 min-w-0">
								{selectedChannel && (
									<button
										type="button"
										onClick={() => setSelectedChannelId(null)}
										className="sm:hidden text-text-muted hover:text-text-default mr-4"
									>
										<RiArrowLeftLine className="size-16" />
									</button>
								)}
								<div className="truncate tr-title-compact text-text-default">
									{selectedChannel ? selectedChannel.name : "Все входящие и исходящие сообщения"}
								</div>
								{selectedChannel && (
									<span className="rounded-full bg-control-bg px-8 py-2 tr-text-eyebrow text-text-muted">
										{selectedChannel.remoteId}
									</span>
								)}
							</div>

							<div className="flex items-center gap-8">
								<button
									type="button"
									data-testid="ask-ai-channel-btn"
									onClick={() => handleAskAgent()}
									className="flex items-center gap-8 rounded-[var(--radius-sm)] bg-control-bg px-12 py-4 tr-text-action text-text-default transition-colors hover:bg-control-bg-hovered"
								>
									<RiSparkling2Line className="size-14 text-primary" />
									<span className="hidden sm:inline">Спросить AI</span>
								</button>
							</div>
						</div>

						{/* Message List */}
						<div data-testid="hub-messages-list" className="flex-1 overflow-y-auto p-16 space-y-12">
							{messages.length === 0 && !loading && (
								<div className="flex h-full flex-col items-center justify-center gap-12 text-center text-text-muted">
									<RiMailLine className="size-36 opacity-40" />
									<div>
										<div className="tr-title-compact text-text-default">Сообщений нет</div>
										<div className="mt-4 tr-text-metadata">
											{unreadOnly
												? "Нет непрочитанных сообщений по выбранному фильтру."
												: "Сообщения не найдены или база пуста."}
										</div>
									</div>
								</div>
							)}

							{messages.map((m) => {
								const isMe = m.senderName === "Me" || m.metadata?.fromMe;
								return (
									<div
										key={m.id}
										data-testid={`hub-message-bubble-${m.id}`}
										className={`flex flex-col ${isMe ? "items-end" : "items-start"}`}
									>
										<div
											className={`group relative max-w-2xl rounded-lg p-12 shadow-xs transition-shadow ${
												isMe
													? "bg-control-primary-bg text-control-primary-text"
													: !m.isRead
														? "border border-feedback-info-subtle bg-container-elevated-bg text-text-default"
														: "border border-border-default bg-container-elevated-bg text-text-default"
											}`}
										>
											{/* Sender & Meta Header */}
											<div className="flex items-center justify-between gap-12 mb-4 tr-text-eyebrow opacity-80">
												<span className="truncate">
													{m.senderName}
													{!isMe && m.senderAddress && ` (${m.senderAddress})`}
												</span>
												<span>{formatTimestamp(m.timestamp)}</span>
											</div>

											{/* Subject / Group line */}
											{m.subject && (
												<div className="mb-8 tr-text-action text-primary">{m.subject}</div>
											)}

											{/* Message Body */}
											<div className="whitespace-pre-wrap break-words tr-text-ui leading-relaxed">
												{m.body}
											</div>

											{/* Footer badges & actions */}
											<div className="mt-8 flex items-center justify-between gap-8 pt-4 border-t border-border-muted">
												<div className="flex items-center gap-8">
													{m.isUrgent && (
														<span className="inline-flex items-center gap-4 rounded-full bg-feedback-error-subtle px-8 py-2 tr-text-eyebrow text-feedback-error">
															<RiAlertLine className="size-12" />
															Срочно
														</span>
													)}
													{!m.isRead && (
														<span className="inline-flex items-center gap-4 rounded-full bg-feedback-info-subtle px-8 py-2 tr-text-eyebrow text-feedback-info">
															Не прочитано
														</span>
													)}
												</div>

												{/* Hover actions */}
												<div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-4">
													{!m.isRead && (
														<button
															type="button"
															onClick={() => handleMarkMessageRead(m.id)}
															className="rounded p-4 hover:bg-control-bg-hovered"
															title="Отметить прочитанным"
														>
															<RiCheckLine className="size-14" />
														</button>
													)}
													<button
														type="button"
														onClick={() => handleAskAgent(m)}
														className="rounded p-4 hover:bg-control-bg-hovered"
														title="Спросить AI-ассистента"
													>
														<RiSparkling2Line className="size-14 text-primary" />
													</button>
												</div>
											</div>
										</div>
									</div>
								);
							})}
						</div>

						{/* Composer Bar */}
						<div
							data-testid="hub-messages-composer"
							className="flex shrink-0 items-center gap-8 border-t border-border-default bg-container-header-bg p-12"
						>
							<input
								type="text"
								value={replyText}
								onChange={(e) => setReplyText(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && !e.shiftKey) {
										e.preventDefault();
										void handleSendMessage();
									}
								}}
								placeholder={
									selectedChannel
										? `Написать ответ в ${selectedChannel.name}...`
										: "Написать сообщение..."
								}
								className="flex-1 rounded-[var(--radius-sm)] border border-border-default bg-control-bg px-12 py-8 tr-text-ui text-text-default placeholder:text-text-muted focus:border-primary focus:outline-none"
							/>

							<button
								type="button"
								data-testid="send-message-btn"
								disabled={sending || !replyText.trim()}
								onClick={handleSendMessage}
								className="flex items-center gap-8 rounded-[var(--radius-sm)] bg-control-primary-bg px-16 py-8 tr-text-action text-control-primary-text transition-colors hover:bg-control-primary-bg-hovered disabled:opacity-50"
							>
								<RiSendPlaneFill className="size-14" />
								<span className="hidden sm:inline">Отправить</span>
							</button>
						</div>
					</div>
				</ResizablePanel>
			</ResizablePanelGroup>
		</div>
	);
}
