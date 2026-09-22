import { RiCloseLine, RiRobotLine, RiSendPlaneLine, RiSparkling2Line } from "@remixicon/react";
import { HUB_WORKSPACE_ID } from "@thinkrail/contracts";
import { useEffect, useRef, useState } from "react";
import ChatView from "../chat/ChatView";
import { selectLastOpenChatSession, useAppStore } from "../store";
import { createSessionWithSkillBaseline, getTransport } from "../transport";

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
	const targetWorkspaceId = HUB_WORKSPACE_ID;

	const hubAssistantSessionId = useAppStore((s) => s.hubAssistantSessionId);
	const hubAssistantWorkspaceId = useAppStore((s) => s.hubAssistantWorkspaceId);

	const [activeTab, setActiveTab] = useState<"hub" | "ide">("hub");
	const [input, setInput] = useState("");
	const [isProcessing, setIsProcessing] = useState(false);
	const [isInitializing, setIsInitializing] = useState(false);

	const [messages, setMessages] = useState<AssistantMessage[]>([
		{
			id: "welcome",
			role: "assistant",
			text: "Привет! Я ваш персональный AI-ассистент. Я могу помочь разобрать почту и чаты, найти нужные сообщения, подготовить сводку за день и написать ответы. Чем помочь?",
			timestamp: Date.now(),
		},
	]);

	const messagesEndRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const isInteractingWithSidebarRef = useRef(false);
	const isInitializingRef = useRef(false);
	const initAttemptedWorkspaceRef = useRef<string | null>(null);
	const handleSendPromptRef = useRef<((promptText: string) => Promise<void>) | null>(null);

	// Automatically initialize a real in-process Pi Agent session for Hub Assistant if a workspace exists
	useEffect(() => {
		if (
			!isOpen ||
			!targetWorkspaceId ||
			(hubAssistantSessionId && hubAssistantWorkspaceId === targetWorkspaceId) ||
			isInitializingRef.current ||
			initAttemptedWorkspaceRef.current === targetWorkspaceId
		) {
			return;
		}

		isInitializingRef.current = true;
		initAttemptedWorkspaceRef.current = targetWorkspaceId;
		setIsInitializing(true);

		void createSessionWithSkillBaseline({ workspaceId: targetWorkspaceId })
			.then(({ result: { sessionId, model, thinkingLevel }, syncedTick }) => {
				const store = useAppStore.getState();
				store.openChatSession(targetWorkspaceId, sessionId, model, thinkingLevel, syncedTick, {
					activate: false,
				});
				store.setHubAssistantSession(targetWorkspaceId, sessionId);
			})
			.catch((err) => {
				initAttemptedWorkspaceRef.current = null;
				console.error("Failed to initialize Hub AI Assistant session:", err);
			})
			.finally(() => {
				isInitializingRef.current = false;
				setIsInitializing(false);
			});
	}, [isOpen, targetWorkspaceId, hubAssistantSessionId, hubAssistantWorkspaceId]);

	// Listen for quick action prompts from Dashboard / Proxy tabs
	useEffect(() => {
		const handleCustomPrompt = (e: Event) => {
			const customEvent = e as CustomEvent<{ prompt: string }>;
			if (customEvent.detail?.prompt) {
				void handleSendPromptRef.current?.(customEvent.detail.prompt);
			}
		};

		window.addEventListener("thinkrail:hub-prompt", handleCustomPrompt);
		return () => {
			window.removeEventListener("thinkrail:hub-prompt", handleCustomPrompt);
		};
	}, []);

	// Ensure keystrokes typed while hovering over the assistant sidebar focus the input
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (!isInteractingWithSidebarRef.current) return;
			if (e.target === inputRef.current) return;
			if (
				!e.ctrlKey &&
				!e.metaKey &&
				!e.altKey &&
				e.key.length === 1 &&
				document.activeElement !== inputRef.current
			) {
				inputRef.current?.focus();
			}
		};
		window.addEventListener("keydown", handleKeyDown, true);
		return () => window.removeEventListener("keydown", handleKeyDown, true);
	}, []);

	const handleSendPrompt = async (promptText: string) => {
		const query = promptText.trim();
		if (!query || isProcessing) return;

		const currentWsId =
			activeTab === "ide" && activeWorkspaceId
				? activeWorkspaceId
				: (hubAssistantWorkspaceId ?? targetWorkspaceId);

		let currentSessionId =
			activeTab === "ide" && lastSessionId ? lastSessionId : hubAssistantSessionId;

		if (!currentSessionId && currentWsId) {
			try {
				setIsProcessing(true);
				const {
					result: { sessionId, model, thinkingLevel },
					syncedTick,
				} = await createSessionWithSkillBaseline({ workspaceId: currentWsId });
				const store = useAppStore.getState();
				store.openChatSession(currentWsId, sessionId, model, thinkingLevel, syncedTick, {
					activate: false,
				});
				store.setHubAssistantSession(currentWsId, sessionId);
				currentSessionId = sessionId;
			} catch (err) {
				console.error("Failed to initialize session for prompt:", err);
			} finally {
				setIsProcessing(false);
			}
		}

		if (currentSessionId && currentWsId) {
			try {
				setIsProcessing(true);
				await getTransport().request("session.prompt", {
					sessionId: currentSessionId,
					text: query,
				});
				setInput("");
			} catch (err) {
				console.error("Failed to send prompt to assistant:", err);
			} finally {
				setIsProcessing(false);
			}
			return;
		}

		// Fallback for mock/test static markup
		const userMsg: AssistantMessage = {
			id: `user-${Date.now()}`,
			role: "user",
			text: query,
			timestamp: Date.now(),
		};
		setMessages((prev) => [...prev, userMsg]);
		setInput("");
	};
	handleSendPromptRef.current = handleSendPrompt;

	if (!isOpen) return null;

	const effectiveSessionId =
		activeTab === "ide" && lastSessionId ? lastSessionId : hubAssistantSessionId;

	const effectiveWorkspaceId =
		activeTab === "ide" && activeWorkspaceId
			? activeWorkspaceId
			: (hubAssistantWorkspaceId ?? targetWorkspaceId);

	return (
		<aside
			data-testid="hub-assistant-sidebar"
			onMouseEnter={() => {
				isInteractingWithSidebarRef.current = true;
			}}
			onMouseLeave={() => {
				isInteractingWithSidebarRef.current = false;
			}}
			onPointerDown={() => {
				isInteractingWithSidebarRef.current = true;
			}}
			className="relative z-10 flex h-full w-[380px] shrink-0 flex-col border-l border-border-default bg-container-sidebar-bg"
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
								Personal Agent
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
					) : (
						<span className="tr-text-metadata text-text-muted">Personal Agent</span>
					)}

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

			{/* Quick Action Suggestion Chips Bar */}
			<div className="shrink-0 border-b border-border-default bg-container-header-bg p-8">
				<div className="flex flex-wrap gap-8">
					<button
						type="button"
						onClick={() =>
							void handleSendPrompt("Summarize unread messages from today across all channels")
						}
						className="rounded-full border border-border-default bg-control-bg px-8 py-4 tr-text-metadata text-text-muted transition-colors hover:bg-control-bg-hovered hover:text-text-default"
					>
						Summarize unread
					</button>
					<button
						type="button"
						onClick={() =>
							void handleSendPrompt("Check urgent communications and summarize priority items")
						}
						className="rounded-full border border-border-default bg-control-bg px-8 py-4 tr-text-metadata text-text-muted transition-colors hover:bg-control-bg-hovered hover:text-text-default"
					>
						Check urgent
					</button>
					<button
						type="button"
						onClick={() => void handleSendPrompt("Draft reply to the latest message")}
						className="rounded-full border border-border-default bg-control-bg px-8 py-4 tr-text-metadata text-text-muted transition-colors hover:bg-control-bg-hovered hover:text-text-default"
					>
						Draft reply
					</button>
				</div>
			</div>

			{/* Body: Live ChatView Session or Fallback Transcript Container */}
			{effectiveSessionId && effectiveWorkspaceId ? (
				<div className="flex-1 min-h-0 min-w-0">
					<ChatView workspaceId={effectiveWorkspaceId} sessionId={effectiveSessionId} />
				</div>
			) : isInitializing ? (
				<div className="flex flex-1 flex-col items-center justify-center p-16 gap-8 tr-text-ui text-text-muted">
					<RiSparkling2Line className="size-20 text-primary animate-spin" />
					<span>Подключение персонального AI-ассистента...</span>
				</div>
			) : (
				<div className="flex flex-1 flex-col overflow-hidden">
					{/* Message Transcript Container */}
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
						<div ref={messagesEndRef} />
					</div>

					{/* Fallback Composer */}
					<div className="border-t border-border-default p-12 bg-container-sidebar-bg">
						<form
							onSubmit={(e) => {
								e.preventDefault();
								void handleSendPrompt(input);
							}}
							className="flex items-center gap-8"
						>
							<input
								ref={inputRef}
								data-testid="hub-assistant-input"
								type="text"
								value={input}
								onFocus={() => {
									isInteractingWithSidebarRef.current = true;
								}}
								onChange={(e) => setInput(e.target.value)}
								placeholder="Ask agent to triage, search, draft..."
								className="flex-1 rounded-[var(--radius-sm)] border border-border-default bg-container-content-bg px-12 py-8 tr-text-metadata text-text-default placeholder:text-text-muted focus:border-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
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
