import { RiCloseLine, RiRobotLine, RiSendPlaneLine, RiSparkling2Line } from "@remixicon/react";
import { useEffect, useRef, useState } from "react";
import ChatView from "../chat/ChatView";
import { selectLastOpenChatSession, useAppStore } from "../store";

interface AssistantMessage {
	id: string;
	role: "user" | "assistant";
	text: string;
	timestamp: number;
}

export function HubAssistantSidebar() {
	const isOpen = useAppStore((s) => s.hubAssistantSidebarOpen);
	const activeWorkspaceId = useAppStore((s) => s.activeWorkspaceId);
	const lastSessionId = useAppStore((s) =>
		activeWorkspaceId ? selectLastOpenChatSession(s, activeWorkspaceId) : null,
	);
	const dashboard = useAppStore((s) => s.hubDashboard);
	const accounts = useAppStore((s) => s.hubAccounts);

	const [activeTab, setActiveTab] = useState<"hub" | "ide">(lastSessionId ? "ide" : "hub");
	const [input, setInput] = useState("");
	const [isProcessing, setIsProcessing] = useState(false);
	const [messages, setMessages] = useState<AssistantMessage[]>([
		{
			id: "welcome",
			role: "assistant",
			text: "Hello! I am your Personal AI Agent. I can triage your inbox, search across your communication channels, summarize conversations, and draft responses. How can I help you today?",
			timestamp: Date.now(),
		},
	]);

	const messagesEndRef = useRef<HTMLDivElement>(null);

	const scrollToBottom = () => {
		messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
	};

	useEffect(() => {
		scrollToBottom();
	}, [messages]);

	// Listen for quick action prompts from Dashboard / Proxy tabs
	useEffect(() => {
		const handleCustomPrompt = (e: Event) => {
			const customEvent = e as CustomEvent<{ prompt: string }>;
			if (customEvent.detail?.prompt) {
				handleSendPrompt(customEvent.detail.prompt);
			}
		};

		window.addEventListener("thinkrail:hub-prompt", handleCustomPrompt);
		return () => {
			window.removeEventListener("thinkrail:hub-prompt", handleCustomPrompt);
		};
	}, [dashboard, accounts]);

	const handleSendPrompt = (promptText: string) => {
		const query = promptText.trim();
		if (!query) return;

		const userMsg: AssistantMessage = {
			id: `user-${Date.now()}`,
			role: "user",
			text: query,
			timestamp: Date.now(),
		};

		setMessages((prev) => [...prev, userMsg]);
		setInput("");
		setIsProcessing(true);

		setTimeout(() => {
			let reply = "";
			const lower = query.toLowerCase();

			if (lower.includes("summarize") || lower.includes("summary") || lower.includes("unread")) {
				const total =
					dashboard?.totalUnread ?? accounts.reduce((sum, a) => sum + (a.unreadCount || 0), 0);
				const urgent = dashboard?.urgentMessages ?? [];
				reply = `📊 **Daily Inbox Summary**:\n- Total unread items: **${total}** across ${accounts.length} configured channels.\n- Urgent triage items: **${urgent.length}** requiring your attention.\n\n${
					urgent.length > 0
						? "Key urgent communications:\n" +
							urgent
								.slice(0, 3)
								.map((m) => `• **${m.senderName}**: "${m.subject || m.snippet}"`)
								.join("\n")
						: "No urgent flags detected right now."
				}`;
			} else if (lower.includes("urgent")) {
				const urgent = dashboard?.urgentMessages ?? [];
				if (urgent.length === 0) {
					reply = "✅ Great news: There are no urgent items requiring immediate action.";
				} else {
					reply =
						`⚠️ **Urgent Items (${urgent.length})**:\n` +
						urgent
							.map(
								(m) =>
									`• **${m.senderName}** (${m.senderAddress}): ${m.subject ?? "No subject"}\n  "${m.snippet}"`,
							)
							.join("\n\n");
				}
			} else if (lower.includes("draft") || lower.includes("reply") || lower.includes("standup")) {
				reply = `✍️ **Draft Response**:\n\n"Hi everyone,\n\nHere is my quick update for today:\n- Reviewing urgent incoming requests across Telegram and Email.\n- Continuing development and code review in active worktrees.\n- No current blockers.\n\nBest regards,\nAlex"`;
			} else {
				reply = `I have received your request: "${query}". I am monitoring all connected channels and ready to assist with triage or drafts.`;
			}

			const botMsg: AssistantMessage = {
				id: `bot-${Date.now()}`,
				role: "assistant",
				text: reply,
				timestamp: Date.now(),
			};

			setMessages((prev) => [...prev, botMsg]);
			setIsProcessing(false);
		}, 400);
	};

	if (!isOpen) return null;

	return (
		<aside
			data-testid="hub-assistant-sidebar"
			className="flex h-full w-[380px] shrink-0 flex-col border-l border-border-default bg-container-sidebar-bg"
		>
			{/* Header */}
			<div className="flex h-44 shrink-0 items-center justify-between border-b border-border-default px-16">
				<div className="flex items-center gap-8">
					<RiSparkling2Line className="size-16 text-primary" />
					<span className="tr-title-compact text-text-default">AI Assistant</span>
				</div>

				<div className="flex items-center gap-8">
					{lastSessionId && activeWorkspaceId ? (
						<div className="flex rounded-[var(--radius-xs)] bg-control-bg p-2 tr-text-metadata">
							<button
								type="button"
								onClick={() => setActiveTab("hub")}
								className={`rounded-[var(--radius-xs)] px-8 py-2 transition-colors ${
									activeTab === "hub"
										? "bg-control-bg-selected text-text-default"
										: "text-text-muted hover:text-text-default"
								}`}
							>
								Hub
							</button>
							<button
								type="button"
								onClick={() => setActiveTab("ide")}
								className={`rounded-[var(--radius-xs)] px-8 py-2 transition-colors ${
									activeTab === "ide"
										? "bg-control-bg-selected text-text-default"
										: "text-text-muted hover:text-text-default"
								}`}
							>
								IDE Chat
							</button>
						</div>
					) : null}

					<button
						type="button"
						data-testid="close-assistant-sidebar-btn"
						onClick={() => useAppStore.getState().setHubAssistantSidebarOpen(false)}
						className="flex size-24 items-center justify-center rounded-[var(--radius-xs)] text-text-muted transition-colors hover:bg-control-bg-hovered hover:text-text-default"
						title="Close assistant panel"
					>
						<RiCloseLine className="size-16" />
					</button>
				</div>
			</div>

			{/* Body: IDE Chat or Hub Assistant Pane */}
			{activeTab === "ide" && activeWorkspaceId && lastSessionId ? (
				<div className="flex-1 min-h-0 min-w-0">
					<ChatView workspaceId={activeWorkspaceId} sessionId={lastSessionId} />
				</div>
			) : (
				<div className="flex flex-1 flex-col overflow-hidden">
					{/* Message Transcript */}
					<div
						data-testid="assistant-messages-container"
						className="flex-1 overflow-y-auto p-16 space-y-12"
					>
						{messages.map((m) => (
							<div
								key={m.id}
								className={`flex flex-col ${m.role === "user" ? "items-end" : "items-start"}`}
							>
								<div className="mb-4 flex items-center gap-8 tr-text-metadata text-text-muted">
									{m.role === "assistant" ? (
										<>
											<RiRobotLine className="size-12 text-primary" />
											<span>Personal Agent</span>
										</>
									) : (
										<span>You</span>
									)}
								</div>
								<div
									className={`max-w-[85%] rounded-[var(--radius-md)] p-12 tr-text-metadata whitespace-pre-wrap ${
										m.role === "user"
											? "bg-control-primary-bg text-control-primary-text"
											: "border border-border-default bg-container-content-bg text-text-default shadow-xs"
									}`}
								>
									{m.text}
								</div>
							</div>
						))}

						{isProcessing ? (
							<div className="flex items-center gap-8 tr-text-metadata text-text-muted animate-pulse">
								<RiSparkling2Line className="size-14 text-primary" />
								<span>Agent is analyzing...</span>
							</div>
						) : null}

						<div ref={messagesEndRef} />
					</div>

					{/* Quick Action Suggestion Chips */}
					<div className="border-t border-border-default bg-container-header-bg p-8">
						<div className="flex flex-wrap gap-8">
							<button
								type="button"
								onClick={() => handleSendPrompt("Summarize all unread messages from today")}
								className="rounded-full border border-border-default bg-control-bg px-8 py-4 tr-text-metadata text-text-muted transition-colors hover:text-text-default"
							>
								Summarize unread
							</button>
							<button
								type="button"
								onClick={() => handleSendPrompt("Check urgent communications")}
								className="rounded-full border border-border-default bg-control-bg px-8 py-4 tr-text-metadata text-text-muted transition-colors hover:text-text-default"
							>
								Check urgent
							</button>
							<button
								type="button"
								onClick={() => handleSendPrompt("Draft a polite reply to latest email")}
								className="rounded-full border border-border-default bg-control-bg px-8 py-4 tr-text-metadata text-text-muted transition-colors hover:text-text-default"
							>
								Draft reply
							</button>
						</div>
					</div>

					{/* Input Composer */}
					<div className="border-t border-border-default p-12 bg-container-sidebar-bg">
						<form
							onSubmit={(e) => {
								e.preventDefault();
								handleSendPrompt(input);
							}}
							className="flex items-center gap-8"
						>
							<input
								data-testid="hub-assistant-input"
								type="text"
								value={input}
								onChange={(e) => setInput(e.target.value)}
								placeholder="Ask agent to triage, search, draft..."
								className="flex-1 rounded-[var(--radius-sm)] border border-border-default bg-container-content-bg px-12 py-8 tr-text-metadata text-text-default placeholder:text-text-muted focus:border-primary focus:outline-none"
							/>
							<button
								type="submit"
								data-testid="hub-assistant-send-btn"
								disabled={!input.trim() || isProcessing}
								className="flex size-30 shrink-0 items-center justify-center rounded-[var(--radius-sm)] bg-control-primary-bg text-control-primary-text transition-colors hover:bg-control-primary-bg-hovered disabled:opacity-40"
							>
								<RiSendPlaneLine className="size-14" />
							</button>
						</form>
					</div>
				</div>
			)}
		</aside>
	);
}
