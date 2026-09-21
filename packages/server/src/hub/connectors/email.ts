import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import * as net from "node:net";
import * as tls from "node:tls";
import type { HubMessage, HubSendMessageParams, HubSendMessageResult } from "@thinkrail/contracts";
import { logger } from "../../log";
import type { EmailAccountConfig } from "../accounts";
import {
	detectMessageUrgency,
	generateMessageSnippet,
	getAccount,
	getHubDb,
	saveIncomingMessages,
	saveMessage,
	updateAccountStatus,
} from "../db";
import { registerHubAccountSyncer, registerHubMessageSender } from "../handlers";
import { publishHubAccountStatus, publishHubMessage } from "../publishers";

const log = logger("hub:email");

// ---------------------------------------------------------------------------
// Email parsing utilities
// ---------------------------------------------------------------------------

export interface ParsedEmailAddress {
	name: string;
	address: string;
}

export function parseEmailAddress(raw: string): ParsedEmailAddress {
	const trimmed = raw.trim();
	const match = trimmed.match(/^(?:"?([^"]*)"?\s*)?<([^>]+)>$/);
	if (match) {
		const name = (match[1] ?? "").trim();
		const address = (match[2] ?? "").trim().toLowerCase();
		return {
			name: name || address,
			address,
		};
	}

	return {
		name: trimmed,
		address: trimmed.toLowerCase(),
	};
}

export function parseEmailHeaders(rawHeaders: string): Record<string, string> {
	const headers: Record<string, string> = {};
	const lines = rawHeaders.split(/\r?\n/);

	let currentKey = "";
	let currentValue = "";

	for (const line of lines) {
		if (/^[ \t]/.test(line) && currentKey) {
			currentValue += ` ${line.trim()}`;
		} else {
			if (currentKey) {
				headers[currentKey.toLowerCase()] = currentValue.trim();
			}
			const colonIndex = line.indexOf(":");
			if (colonIndex > 0) {
				currentKey = line.slice(0, colonIndex).trim();
				currentValue = line.slice(colonIndex + 1).trim();
			} else {
				currentKey = "";
				currentValue = "";
			}
		}
	}

	if (currentKey) {
		headers[currentKey.toLowerCase()] = currentValue.trim();
	}

	return headers;
}

export function parseEmailBody(
	rawBody: string,
	contentType = "text/plain",
): { text: string; snippet: string } {
	let body = rawBody;

	// Handle multipart boundary if present
	const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
	if (boundaryMatch) {
		const boundary = boundaryMatch[1] ?? boundaryMatch[2];
		if (boundary) {
			const parts = rawBody.split(new RegExp(`--${boundary}(?:--)?`));
			let plainPart = "";
			let htmlPart = "";

			for (const part of parts) {
				const trimmedPart = part.trim();
				if (!trimmedPart) continue;
				const headerEnd = trimmedPart.search(/\r?\n\r?\n/);
				if (headerEnd > 0) {
					const partHeaders = parseEmailHeaders(trimmedPart.slice(0, headerEnd));
					const partContent = trimmedPart.slice(headerEnd).trim();
					const partType = (partHeaders["content-type"] ?? "").toLowerCase();

					if (partType.includes("text/plain")) {
						plainPart = partContent;
					} else if (partType.includes("text/html")) {
						htmlPart = partContent;
					}
				}
			}

			if (plainPart) {
				body = plainPart;
			} else if (htmlPart) {
				body = htmlPart.replace(/<[^>]+>/g, " ");
			}
		}
	} else if (contentType.includes("text/html")) {
		body = body.replace(/<[^>]+>/g, " ");
	}

	const snippet = generateMessageSnippet(body);
	return { text: body.trim(), snippet };
}

export interface ParsedEmailMessage {
	headers: Record<string, string>;
	subject: string;
	from: ParsedEmailAddress;
	to: string;
	body: string;
	snippet: string;
	timestamp: number;
	messageId: string;
	isUrgent: boolean;
}

export function parseRawRfc822(rawRfc822: string): ParsedEmailMessage {
	const headerEnd = rawRfc822.search(/\r?\n\r?\n/);
	const rawHeaders = headerEnd >= 0 ? rawRfc822.slice(0, headerEnd) : "";
	const rawBody = headerEnd >= 0 ? rawRfc822.slice(headerEnd).trim() : rawRfc822;

	const headers = parseEmailHeaders(rawHeaders);
	const from = parseEmailAddress(headers.from ?? "unknown@example.com");
	const to = headers.to ?? "";
	const subject = headers.subject ?? "(No Subject)";
	const parsedDate = headers.date ? Date.parse(headers.date) : Number.NaN;
	const timestamp = Number.isNaN(parsedDate) ? Date.now() : parsedDate;
	const messageId = (headers["message-id"] ?? `<msg-${randomUUID()}@local>`).replace(/[<>]/g, "");

	const { text, snippet } = parseEmailBody(rawBody, headers["content-type"]);
	const isUrgent = detectMessageUrgency(subject, text, headers);

	return {
		headers,
		subject,
		from,
		to,
		body: text,
		snippet,
		timestamp,
		messageId,
		isUrgent,
	};
}

// ---------------------------------------------------------------------------
// IMAP Client Interfaces & Implementations
// ---------------------------------------------------------------------------

export interface FetchedEmailItem {
	seq: number;
	uid: string;
	flags: string[];
	headers: Record<string, string>;
	rawRfc822: string;
	date?: number;
}

export interface ImapClientInterface {
	connect(): Promise<void>;
	login(user: string, pass: string): Promise<void>;
	select(mailbox?: string): Promise<{ exists: number; recent: number; unseen?: number }>;
	search(query?: string): Promise<number[]>;
	fetch(seqRange: string): Promise<FetchedEmailItem[]>;
	logout(): Promise<void>;
	close(): void;
}

export class MockImapClient implements ImapClientInterface {
	public connected = false;
	public loggedIn = false;
	public selectedMailbox = "";
	public messages: FetchedEmailItem[] = [];

	constructor(messages: FetchedEmailItem[] = []) {
		this.messages = [...messages];
	}

	async connect(): Promise<void> {
		this.connected = true;
	}

	async login(_user: string, _pass: string): Promise<void> {
		this.loggedIn = true;
	}

	async select(mailbox = "INBOX"): Promise<{ exists: number; recent: number; unseen?: number }> {
		this.selectedMailbox = mailbox;
		const unseen = this.messages.filter((m) => !m.flags.includes("\\Seen")).length;
		return {
			exists: this.messages.length,
			recent: this.messages.length,
			unseen,
		};
	}

	async search(_query = "ALL"): Promise<number[]> {
		return this.messages.map((m) => m.seq);
	}

	async fetch(_seqRange: string): Promise<FetchedEmailItem[]> {
		return [...this.messages];
	}

	async logout(): Promise<void> {
		this.loggedIn = false;
		this.connected = false;
	}

	close(): void {
		this.loggedIn = false;
		this.connected = false;
	}
}

export class SocketImapClient implements ImapClientInterface {
	private socket: net.Socket | tls.TLSSocket | null = null;
	private host: string;
	private port: number;
	private useTls: boolean;
	private tagCounter = 0;
	private buffer = "";
	private lineWaiters: Array<{
		expectedTag?: string;
		resolve: (lines: string[]) => void;
		reject: (err: Error) => void;
	}> = [];

	constructor(options: { host: string; port?: number; tls?: boolean }) {
		this.host = options.host;
		this.port = options.port ?? (options.tls !== false ? 993 : 143);
		this.useTls = options.tls !== false;
	}

	private nextTag(): string {
		this.tagCounter += 1;
		return `A${String(this.tagCounter).padStart(4, "0")}`;
	}

	async connect(): Promise<void> {
		return new Promise((resolve, reject) => {
			const onConnect = () => {
				resolve();
			};

			const onError = (err: Error) => {
				reject(err);
			};

			if (this.useTls) {
				this.socket = tls.connect(
					{
						host: this.host,
						port: this.port,
						rejectUnauthorized: false,
					},
					onConnect,
				);
			} else {
				this.socket = net.connect(
					{
						host: this.host,
						port: this.port,
					},
					onConnect,
				);
			}

			this.socket.on("error", onError);
			this.socket.on("data", (chunk: Buffer) => {
				this.handleData(chunk.toString("utf8"));
			});
			this.socket.on("close", () => {
				this.socket = null;
			});
		});
	}

	private handleData(text: string): void {
		this.buffer += text;
		const lines = this.buffer.split(/\r?\n/);
		this.buffer = lines.pop() ?? "";

		if (this.lineWaiters.length > 0) {
			const waiter = this.lineWaiters[0];
			if (!waiter) return;

			if (waiter.expectedTag) {
				const tagLine = lines.find((l) => l.startsWith(`${waiter.expectedTag} `));
				if (tagLine) {
					this.lineWaiters.shift();
					if (tagLine.startsWith(`${waiter.expectedTag} OK`)) {
						waiter.resolve(lines);
					} else {
						waiter.reject(new Error(`IMAP command failed: ${tagLine}`));
					}
				}
			}
		}
	}

	private sendCommand(command: string, expectedTag?: string): Promise<string[]> {
		return new Promise((resolve, reject) => {
			if (!this.socket) {
				return reject(new Error("Socket is not connected"));
			}

			const timer = setTimeout(() => {
				const idx = this.lineWaiters.findIndex((w) => w.expectedTag === expectedTag);
				if (idx >= 0) {
					this.lineWaiters.splice(idx, 1);
				}
				reject(new Error(`IMAP timeout waiting for ${command}`));
			}, 15000);

			this.lineWaiters.push({
				...(expectedTag ? { expectedTag } : {}),
				resolve: (lines) => {
					clearTimeout(timer);
					resolve(lines);
				},
				reject: (err) => {
					clearTimeout(timer);
					reject(err);
				},
			});

			this.socket.write(`${command}\r\n`);
		});
	}

	async login(user: string, pass: string): Promise<void> {
		const tag = this.nextTag();
		await this.sendCommand(`${tag} LOGIN "${user}" "${pass}"`, tag);
	}

	async select(mailbox = "INBOX"): Promise<{ exists: number; recent: number; unseen?: number }> {
		const tag = this.nextTag();
		const lines = await this.sendCommand(`${tag} SELECT "${mailbox}"`, tag);

		let exists = 0;
		let recent = 0;
		let unseen: number | undefined;

		for (const line of lines) {
			const existsMatch = line.match(/\*\s+(\d+)\s+EXISTS/i);
			if (existsMatch) exists = Number.parseInt(existsMatch[1] ?? "0", 10);

			const recentMatch = line.match(/\*\s+(\d+)\s+RECENT/i);
			if (recentMatch) recent = Number.parseInt(recentMatch[1] ?? "0", 10);

			const unseenMatch = line.match(/\*\s+OK\s+\[UNSEEN\s+(\d+)\]/i);
			if (unseenMatch) unseen = Number.parseInt(unseenMatch[1] ?? "0", 10);
		}

		return {
			exists,
			recent,
			...(unseen !== undefined ? { unseen } : {}),
		};
	}

	async search(query = "ALL"): Promise<number[]> {
		const tag = this.nextTag();
		const lines = await this.sendCommand(`${tag} SEARCH ${query}`, tag);

		const result: number[] = [];
		for (const line of lines) {
			if (line.startsWith("* SEARCH")) {
				const parts = line.slice(8).trim().split(/\s+/);
				for (const p of parts) {
					const num = Number.parseInt(p, 10);
					if (!Number.isNaN(num)) result.push(num);
				}
			}
		}

		return result;
	}

	async fetch(seqRange: string): Promise<FetchedEmailItem[]> {
		const tag = this.nextTag();
		const lines = await this.sendCommand(
			`${tag} FETCH ${seqRange} (UID FLAGS RFC822.HEADER RFC822.TEXT)`,
			tag,
		);

		const items: FetchedEmailItem[] = [];
		let currentItem: Partial<FetchedEmailItem> | null = null;
		let capturingBody = false;
		let rawContent = "";

		for (const line of lines) {
			const fetchMatch = line.match(/\*\s+(\d+)\s+FETCH\s+\((.*)/i);
			if (fetchMatch) {
				if (currentItem?.seq) {
					items.push({
						seq: currentItem.seq,
						uid: currentItem.uid ?? String(currentItem.seq),
						flags: currentItem.flags ?? [],
						headers: currentItem.headers ?? {},
						rawRfc822: rawContent,
					});
				}

				const seq = Number.parseInt(fetchMatch[1] ?? "1", 10);
				const details = fetchMatch[2] ?? "";
				const uidMatch = details.match(/UID\s+(\d+)/i);
				const flagsMatch = details.match(/FLAGS\s+\(([^)]*)\)/i);

				currentItem = {
					seq,
					uid: uidMatch?.[1] ? uidMatch[1] : String(seq),
					flags: flagsMatch ? (flagsMatch[1] ?? "").split(/\s+/).filter(Boolean) : [],
					headers: {},
				};
				capturingBody = true;
				rawContent = "";
				continue;
			}

			if (capturingBody) {
				if (line.startsWith(`${tag} OK`)) {
					capturingBody = false;
					if (currentItem?.seq) {
						items.push({
							seq: currentItem.seq,
							uid: currentItem.uid ?? String(currentItem.seq),
							flags: currentItem.flags ?? [],
							headers: currentItem.headers ?? {},
							rawRfc822: rawContent,
						});
					}
					currentItem = null;
				} else {
					rawContent += `${line}\r\n`;
				}
			}
		}

		if (currentItem?.seq) {
			items.push({
				seq: currentItem.seq,
				uid: currentItem.uid ?? String(currentItem.seq),
				flags: currentItem.flags ?? [],
				headers: currentItem.headers ?? {},
				rawRfc822: rawContent,
			});
		}

		return items;
	}

	async logout(): Promise<void> {
		try {
			const tag = this.nextTag();
			await this.sendCommand(`${tag} LOGOUT`, tag);
		} finally {
			this.close();
		}
	}

	close(): void {
		if (this.socket) {
			this.socket.destroy();
			this.socket = null;
		}
	}
}

// ---------------------------------------------------------------------------
// SMTP Client Interfaces & Implementations
// ---------------------------------------------------------------------------

export interface SendEmailOptions {
	from: string;
	to: string;
	subject: string;
	body: string;
	replyTo?: string;
	headers?: Record<string, string>;
}

export interface SmtpClientInterface {
	send(options: SendEmailOptions): Promise<{ messageId: string }>;
	close(): void;
}

export class MockSmtpClient implements SmtpClientInterface {
	public sentMessages: Array<SendEmailOptions & { messageId: string }> = [];

	async send(options: SendEmailOptions): Promise<{ messageId: string }> {
		const messageId = `<msg-${randomUUID()}@local>`;
		this.sentMessages.push({ ...options, messageId });
		return { messageId };
	}

	close(): void {}
}

interface SmtpReply {
	code: number;
	lines: string[];
	raw: string;
}

/**
 * Direct SMTP client connecting over TLS (SMTPS, default port 465) or plain TCP (default port 587).
 * Implements full RFC 5321 conversational request-response sequencing:
 *  - Reads server greeting (220)
 *  - Sends EHLO (falls back to HELO on 500/502) (250)
 *  - Authenticates with AUTH LOGIN if credentials provided (334, 334, 235)
 *  - Issues MAIL FROM:<...> (250)
 *  - Issues RCPT TO:<...> (250 / 251)
 *  - Requests DATA (354)
 *  - Transmits message body with RFC 5321 dot-stuffing and end marker (250)
 *  - Sends QUIT
 * Resolves only upon successful 250 response to the message data transmission.
 */
export class SocketSmtpClient implements SmtpClientInterface {
	private host: string;
	private port: number;
	private useTls: boolean;
	private user?: string;
	private password?: string;
	private timeoutMs: number;
	private activeSocket: net.Socket | tls.TLSSocket | null = null;

	constructor(options: {
		host: string;
		port?: number;
		tls?: boolean;
		user?: string;
		password?: string;
		timeoutMs?: number;
	}) {
		this.host = options.host;
		this.port = options.port ?? (options.tls !== false ? 465 : 587);
		this.useTls = options.tls !== false;
		this.timeoutMs = options.timeoutMs ?? 15000;
		if (options.user !== undefined) this.user = options.user;
		if (options.password !== undefined) this.password = options.password;
	}

	async send(options: SendEmailOptions): Promise<{ messageId: string }> {
		const messageId = `<msg-${randomUUID()}@${this.host}>`;

		return new Promise((resolve, reject) => {
			let socket: net.Socket | tls.TLSSocket;
			try {
				if (this.useTls) {
					socket = tls.connect({
						host: this.host,
						port: this.port,
						rejectUnauthorized: false,
						servername: this.host,
					});
				} else {
					socket = net.connect({
						host: this.host,
						port: this.port,
					});
				}
			} catch (err) {
				return reject(err);
			}

			this.activeSocket = socket;

			let buffer = "";
			let accumulatedLines: string[] = [];
			const replyQueue: SmtpReply[] = [];
			let pendingWaiter: {
				resolve: (reply: SmtpReply) => void;
				reject: (err: Error) => void;
				timer: ReturnType<typeof setTimeout>;
			} | null = null;
			let socketClosed = false;
			let socketError: Error | null = null;

			const onData = (chunk: Buffer) => {
				buffer += chunk.toString("utf8");
				let newlineIdx = buffer.indexOf("\n");
				while (newlineIdx !== -1) {
					const line = buffer.slice(0, newlineIdx).replace(/\r$/, "");
					buffer = buffer.slice(newlineIdx + 1);

					const match = line.match(/^(\d{3})(?:([ -])(.*))?$/);
					if (match?.[1]) {
						const code = Number.parseInt(match[1], 10);
						const sep = match[2] ?? " ";
						accumulatedLines.push(line);

						if (sep === " ") {
							const reply: SmtpReply = {
								code,
								lines: accumulatedLines,
								raw: accumulatedLines.join("\r\n"),
							};
							accumulatedLines = [];

							if (pendingWaiter) {
								clearTimeout(pendingWaiter.timer);
								const waiter = pendingWaiter;
								pendingWaiter = null;
								waiter.resolve(reply);
							} else {
								replyQueue.push(reply);
							}
						}
					}
					newlineIdx = buffer.indexOf("\n");
				}
			};

			const onError = (err: Error) => {
				socketError = err;
				if (pendingWaiter) {
					clearTimeout(pendingWaiter.timer);
					const waiter = pendingWaiter;
					pendingWaiter = null;
					waiter.reject(err);
				}
			};

			const onClose = () => {
				socketClosed = true;
				if (pendingWaiter) {
					clearTimeout(pendingWaiter.timer);
					const waiter = pendingWaiter;
					pendingWaiter = null;
					waiter.reject(socketError ?? new Error("SMTP socket closed prematurely"));
				}
			};

			socket.on("data", onData);
			socket.on("error", onError);
			socket.on("close", onClose);

			const readReply = (expectedCodes?: number[]): Promise<SmtpReply> => {
				return new Promise((res, rej) => {
					const verifyAndResolve = (reply: SmtpReply) => {
						if (expectedCodes && !expectedCodes.includes(reply.code)) {
							rej(new Error(`SMTP error (${reply.code}): ${reply.lines.join(" ")}`));
						} else {
							res(reply);
						}
					};

					if (replyQueue.length > 0) {
						const next = replyQueue.shift();
						if (next) {
							verifyAndResolve(next);
							return;
						}
					}

					if (socketClosed) {
						rej(socketError ?? new Error("SMTP socket is already closed"));
						return;
					}

					const timer = setTimeout(() => {
						if (pendingWaiter) {
							pendingWaiter = null;
							rej(new Error(`SMTP timeout waiting for response after ${this.timeoutMs}ms`));
						}
					}, this.timeoutMs);

					pendingWaiter = {
						resolve: verifyAndResolve,
						reject: rej,
						timer,
					};
				});
			};

			const sendCommand = async (command: string, expectedCodes?: number[]): Promise<SmtpReply> => {
				if (socketClosed) {
					throw socketError ?? new Error("SMTP socket closed");
				}
				socket.write(`${command}\r\n`);
				return readReply(expectedCodes);
			};

			const runSmtpSession = async () => {
				try {
					// 1. Await server greeting (220)
					await readReply([220]);

					// 2. EHLO (with HELO fallback)
					let ehlo = await sendCommand("EHLO localhost");
					if (ehlo.code !== 250) {
						ehlo = await sendCommand("HELO localhost", [250]);
					}

					// 3. Authentication
					if (this.user && this.password) {
						await sendCommand("AUTH LOGIN", [334]);
						await sendCommand(Buffer.from(this.user).toString("base64"), [334]);
						await sendCommand(Buffer.from(this.password).toString("base64"), [235]);
					}

					// 4. Envelope From and To
					const fromAddress = parseEmailAddress(options.from).address || options.from;
					const toAddress = parseEmailAddress(options.to).address || options.to;
					await sendCommand(`MAIL FROM:<${fromAddress}>`, [250]);
					await sendCommand(`RCPT TO:<${toAddress}>`, [250, 251]);

					// 5. DATA command
					await sendCommand("DATA", [354]);

					// 6. Dot-stuffing and transmitting body
					const escapedBody = options.body
						.split(/\r?\n/)
						.map((line) => (line.startsWith(".") ? `.${line}` : line))
						.join("\r\n");

					const extraHeaders = options.headers
						? Object.entries(options.headers).map(([k, v]) => `${k}: ${v}`)
						: [];

					const emailData = [
						`From: ${options.from}`,
						`To: ${options.to}`,
						`Subject: ${options.subject}`,
						`Message-ID: ${messageId}`,
						`Date: ${new Date().toUTCString()}`,
						...(options.replyTo ? [`In-Reply-To: ${options.replyTo}`] : []),
						...extraHeaders,
						"",
						escapedBody,
						".",
					].join("\r\n");

					// Must receive 250 OK before considering message sent
					await sendCommand(emailData, [250]);

					// 7. QUIT (best effort)
					try {
						await sendCommand("QUIT", [221]);
					} catch {
						// ignore QUIT response error
					}

					resolve({ messageId });
				} catch (err) {
					reject(err);
				} finally {
					try {
						socket.end();
					} catch {
						// ignore
					}
					this.activeSocket = null;
				}
			};

			runSmtpSession();
		});
	}

	close(): void {
		if (this.activeSocket) {
			try {
				this.activeSocket.destroy();
			} catch {
				// ignore
			}
			this.activeSocket = null;
		}
	}
}

// ---------------------------------------------------------------------------
// Email Connector Core Service
// ---------------------------------------------------------------------------

export class EmailConnector {
	private config: EmailAccountConfig;
	private customImapClient?: ImapClientInterface;
	private customSmtpClient?: SmtpClientInterface;

	constructor(
		config: EmailAccountConfig,
		clients?: {
			imap?: ImapClientInterface;
			smtp?: SmtpClientInterface;
		},
	) {
		this.config = config;
		if (clients?.imap) this.customImapClient = clients.imap;
		if (clients?.smtp) this.customSmtpClient = clients.smtp;
	}

	private getImapClient(): ImapClientInterface {
		if (this.customImapClient) return this.customImapClient;
		return new SocketImapClient({
			host: this.config.imap.host,
			...(this.config.imap.port !== undefined ? { port: this.config.imap.port } : {}),
			...(this.config.imap.tls !== undefined ? { tls: this.config.imap.tls } : {}),
		});
	}

	private getSmtpClient(): SmtpClientInterface {
		if (this.customSmtpClient) return this.customSmtpClient;
		return new SocketSmtpClient({
			host: this.config.smtp?.host ?? this.config.imap.host,
			...(this.config.smtp?.port !== undefined ? { port: this.config.smtp.port } : {}),
			...(this.config.smtp?.tls !== undefined ? { tls: this.config.smtp.tls } : {}),
			...(this.config.smtp?.user ? { user: this.config.smtp.user } : {}),
			...(this.config.smtp?.password ? { password: this.config.smtp.password } : {}),
		});
	}

	async sync(
		options: { maxMessages?: number } = {},
		database?: Database,
	): Promise<{ syncedCount: number; unreadCount: number }> {
		const db = database ?? getHubDb();
		const client = this.getImapClient();
		const maxMessages = options.maxMessages ?? 30;

		try {
			await client.connect();
			if (this.config.imap.password) {
				await client.login(this.config.imap.user, this.config.imap.password);
			}

			const mailbox = this.config.imap.mailbox ?? "INBOX";
			const selectInfo = await client.select(mailbox);
			const seqs = await client.search("ALL");

			// Fetch latest N messages
			const targetSeqs = seqs.slice(-maxMessages);
			let fetchedItems: FetchedEmailItem[] = [];

			if (targetSeqs.length > 0) {
				const rangeStr =
					targetSeqs.length === 1
						? `${targetSeqs[0]}`
						: `${targetSeqs[0]}:${targetSeqs[targetSeqs.length - 1]}`;
				fetchedItems = await client.fetch(rangeStr);
			}

			const incomingMessages: Array<Omit<HubMessage, "id">> = [];

			for (const item of fetchedItems) {
				const parsed = parseRawRfc822(item.rawRfc822);
				const isRead = item.flags.includes("\\Seen");
				const remoteId = parsed.messageId || `uid-${item.uid}`;

				incomingMessages.push({
					accountId: this.config.id,
					remoteId,
					channelId: mailbox,
					senderName: parsed.from.name,
					senderAddress: parsed.from.address,
					recipientAddress: parsed.to || this.config.email,
					subject: parsed.subject,
					body: parsed.body,
					snippet: parsed.snippet,
					timestamp: parsed.timestamp,
					isRead,
					isUrgent: parsed.isUrgent,
					hasAttachments: false,
					metadata: {
						flags: item.flags,
						uid: item.uid,
					},
				});
			}

			const { inserted, updated } = saveIncomingMessages(incomingMessages, undefined, db);

			for (const msg of inserted) {
				publishHubMessage(msg);
			}

			const unreadCount =
				selectInfo.unseen ??
				(db
					.query("SELECT COUNT(*) as count FROM hub_messages WHERE account_id = ? AND is_read = 0;")
					.get(this.config.id) as { count: number });

			const totalUnread = typeof unreadCount === "number" ? unreadCount : (unreadCount?.count ?? 0);

			updateAccountStatus(this.config.id, "connected", totalUnread, null, db);
			publishHubAccountStatus({
				accountId: this.config.id,
				status: "connected",
				unreadCount: totalUnread,
			});

			return {
				syncedCount: inserted.length + updated.length,
				unreadCount: totalUnread,
			};
		} catch (err: unknown) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			log.error(`Email sync error for ${this.config.id}: ${errorMsg}`);
			const existing = getAccount(this.config.id, db);
			const currentUnread = existing?.unreadCount ?? 0;
			updateAccountStatus(this.config.id, "error", currentUnread, errorMsg, db);
			publishHubAccountStatus({
				accountId: this.config.id,
				status: "error",
				unreadCount: currentUnread,
			});
			throw err;
		} finally {
			try {
				await client.logout();
			} catch {
				client.close();
			}
		}
	}

	async send(params: HubSendMessageParams, database?: Database): Promise<HubSendMessageResult> {
		const db = database ?? getHubDb();
		const client = this.getSmtpClient();

		try {
			const sendResult = await client.send({
				from: this.config.email,
				to: params.recipient,
				subject: params.subject ?? "No Subject",
				body: params.body,
				...(params.replyToMessageId ? { replyTo: params.replyToMessageId } : {}),
			});

			const id = randomUUID();
			const message: HubMessage = {
				id,
				accountId: this.config.id,
				remoteId: sendResult.messageId,
				...(params.channelId ? { channelId: params.channelId } : {}),
				senderName: this.config.name,
				senderAddress: this.config.email,
				recipientAddress: params.recipient,
				...(params.subject ? { subject: params.subject } : {}),
				body: params.body,
				snippet: generateMessageSnippet(params.body),
				timestamp: Date.now(),
				isRead: true,
				isUrgent: false,
				hasAttachments: false,
				...(params.replyToMessageId
					? { metadata: { replyToMessageId: params.replyToMessageId } }
					: {}),
			};

			saveMessage(message, db);
			publishHubMessage(message);

			return {
				success: true,
				messageId: id,
			};
		} catch (err: unknown) {
			const error = err instanceof Error ? err.message : String(err);
			log.error(`Email send error for ${this.config.id}: ${error}`);
			return {
				success: false,
				error,
			};
		} finally {
			client.close();
		}
	}
}

// ---------------------------------------------------------------------------
// Registration & Integration Helpers
// ---------------------------------------------------------------------------

export function registerEmailAccount(
	config: EmailAccountConfig,
	clients?: {
		imap?: ImapClientInterface;
		smtp?: SmtpClientInterface;
	},
): EmailConnector {
	const connector = new EmailConnector(config, clients);

	registerHubAccountSyncer(config.id, async (_params) => {
		try {
			await connector.sync();
			return {
				synced: true,
				accountIds: [config.id],
			};
		} catch (err: unknown) {
			return {
				synced: false,
				error: err instanceof Error ? err.message : String(err),
			};
		}
	});

	registerHubMessageSender(config.id, async (params) => {
		return connector.send(params);
	});

	return connector;
}
