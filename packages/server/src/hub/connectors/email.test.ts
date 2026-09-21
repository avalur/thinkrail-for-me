import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type AddressInfo, createServer } from "node:net";
import type { EmailAccountConfig } from "../accounts";
import { getMessage, getMessageByRemoteId, getMessages, initHubSchema, saveAccount } from "../db";
import {
	EmailConnector,
	type FetchedEmailItem,
	MockImapClient,
	MockSmtpClient,
	parseEmailAddress,
	parseEmailBody,
	parseEmailHeaders,
	parseRawRfc822,
	SocketSmtpClient,
} from "./email";

describe("Email Connector", () => {
	let db: Database;

	const testConfig: EmailAccountConfig = {
		id: "email-work-1",
		provider: "email_work",
		name: "Work Mail",
		email: "alex@company.com",
		enabled: true,
		imap: {
			host: "imap.company.com",
			user: "alex@company.com",
			password: "password123",
		},
		smtp: {
			host: "smtp.company.com",
			user: "alex@company.com",
			password: "password123",
		},
	};

	beforeEach(() => {
		db = new Database(":memory:");
		initHubSchema(db);
		saveAccount(
			{
				id: testConfig.id,
				provider: testConfig.provider,
				name: testConfig.name,
				email: testConfig.email,
				status: "connected",
				unreadCount: 0,
				lastSyncAt: null,
			},
			db,
		);
	});

	afterEach(() => {
		db.close();
	});

	describe("Email Parsing Utilities", () => {
		it("parses email addresses correctly in various formats", () => {
			expect(parseEmailAddress('"Alex Avdi" <alex@example.com>')).toEqual({
				name: "Alex Avdi",
				address: "alex@example.com",
			});
			expect(parseEmailAddress("Alex Avdi <alex@example.com>")).toEqual({
				name: "Alex Avdi",
				address: "alex@example.com",
			});
			expect(parseEmailAddress("<alex@example.com>")).toEqual({
				name: "alex@example.com",
				address: "alex@example.com",
			});
			expect(parseEmailAddress("alex@example.com")).toEqual({
				name: "alex@example.com",
				address: "alex@example.com",
			});
		});

		it("parses folded headers properly", () => {
			const raw = [
				"Subject: Urgent project update",
				" from teammate",
				"From: Alice <alice@work.com>",
				"X-Priority: 1",
			].join("\r\n");

			const headers = parseEmailHeaders(raw);
			expect(headers.subject).toBe("Urgent project update from teammate");
			expect(headers.from).toBe("Alice <alice@work.com>");
			expect(headers["x-priority"]).toBe("1");
		});

		it("parses multipart body and strips HTML if needed", () => {
			const multipartBody = [
				"--boundary123",
				"Content-Type: text/plain; charset=utf-8",
				"",
				"Hello team, please review the PR asap.",
				"--boundary123",
				"Content-Type: text/html; charset=utf-8",
				"",
				"<p>Hello team, please review the PR asap.</p>",
				"--boundary123--",
			].join("\r\n");

			const res = parseEmailBody(multipartBody, 'multipart/alternative; boundary="boundary123"');
			expect(res.text).toBe("Hello team, please review the PR asap.");
			expect(res.snippet).toContain("Hello team");
		});

		it("parses full RFC 822 payload and detects urgency", () => {
			const rfc822 = [
				"From: Boss <boss@company.com>",
				"To: Alex <alex@company.com>",
				"Subject: Critical: Production server outage!",
				"Date: Mon, 21 Sep 2026 10:00:00 GMT",
				"Message-ID: <outage-001@company.com>",
				"X-Priority: 1",
				"",
				"The production server is currently down. Immediate attention required!",
			].join("\r\n");

			const parsed = parseRawRfc822(rfc822);
			expect(parsed.subject).toBe("Critical: Production server outage!");
			expect(parsed.from.address).toBe("boss@company.com");
			expect(parsed.from.name).toBe("Boss");
			expect(parsed.messageId).toBe("outage-001@company.com");
			expect(parsed.isUrgent).toBe(true);
		});
	});

	describe("IMAP Synchronization & Deduplication", () => {
		it("synchronizes unread and read emails into SQLite", async () => {
			const msg1: FetchedEmailItem = {
				seq: 1,
				uid: "101",
				flags: [], // unread
				headers: {},
				rawRfc822: [
					"From: Alice <alice@example.com>",
					"To: Alex <alex@company.com>",
					"Subject: Meeting Notes",
					"Message-ID: <msg-101@example.com>",
					"",
					"Here are the notes from our sync.",
				].join("\r\n"),
			};

			const msg2: FetchedEmailItem = {
				seq: 2,
				uid: "102",
				flags: ["\\Seen"], // read
				headers: {},
				rawRfc822: [
					"From: Bob <bob@example.com>",
					"To: Alex <alex@company.com>",
					"Subject: Lunch tomorrow?",
					"Message-ID: <msg-102@example.com>",
					"",
					"Let's grab lunch at noon.",
				].join("\r\n"),
			};

			const mockImap = new MockImapClient([msg1, msg2]);
			const connector = new EmailConnector(testConfig, { imap: mockImap });

			const result = await connector.sync({}, db);
			expect(result.syncedCount).toBe(2);
			expect(result.unreadCount).toBe(1);

			// Verify in DB
			const { total } = getMessages({ accountId: testConfig.id }, db);
			expect(total).toBe(2);

			const savedMsg1 = getMessageByRemoteId(testConfig.id, "msg-101@example.com", db);
			expect(savedMsg1).toBeDefined();
			expect(savedMsg1?.isRead).toBe(false);
			expect(savedMsg1?.subject).toBe("Meeting Notes");

			const savedMsg2 = getMessageByRemoteId(testConfig.id, "msg-102@example.com", db);
			expect(savedMsg2).toBeDefined();
			expect(savedMsg2?.isRead).toBe(true);
		});

		it("deduplicates messages and preserves local read status when resyncing", async () => {
			const rawMsg: FetchedEmailItem = {
				seq: 1,
				uid: "201",
				flags: [], // unread upstream
				headers: {},
				rawRfc822: [
					"From: HR <hr@company.com>",
					"Subject: Benefits Enrollment",
					"Message-ID: <benefits-201@company.com>",
					"",
					"Open enrollment is now active.",
				].join("\r\n"),
			};

			const mockImap = new MockImapClient([rawMsg]);
			const connector = new EmailConnector(testConfig, { imap: mockImap });

			await connector.sync({}, db);
			const msgBefore = getMessageByRemoteId(testConfig.id, "benefits-201@company.com", db);
			expect(msgBefore).toBeDefined();
			expect(msgBefore?.isRead).toBe(false);

			// Mark as read locally in DB
			if (msgBefore) {
				db.run("UPDATE hub_messages SET is_read = 1 WHERE id = ?;", [msgBefore.id]);
			}

			// Resync with the same upstream unread message
			await connector.sync({}, db);

			// Local read status should remain true
			const msgAfter = getMessageByRemoteId(testConfig.id, "benefits-201@company.com", db);
			expect(msgAfter?.isRead).toBe(true);

			// Total count remains 1
			const { total } = getMessages({ accountId: testConfig.id }, db);
			expect(total).toBe(1);
		});
	});

	describe("SMTP Sending", () => {
		it("sends email via SMTP client and records outbound message", async () => {
			const mockSmtp = new MockSmtpClient();
			const connector = new EmailConnector(testConfig, { smtp: mockSmtp });

			const res = await connector.send(
				{
					accountId: testConfig.id,
					recipient: "partner@client.com",
					subject: "Contract Signed",
					body: "Hi partner, the agreement is signed and attached.",
				},
				db,
			);

			expect(res.success).toBe(true);
			expect(res.messageId).toBeDefined();
			expect(mockSmtp.sentMessages.length).toBe(1);
			expect(mockSmtp.sentMessages[0]?.to).toBe("partner@client.com");

			const saved = res.messageId ? getMessage(res.messageId, db) : undefined;
			expect(saved).toBeDefined();
			expect(saved?.recipientAddress).toBe("partner@client.com");
			expect(saved?.body).toContain("agreement is signed");
			expect(saved?.isRead).toBe(true);
		});
	});

	describe("SocketSmtpClient Request/Response Protocol Flow", () => {
		it("completes full SMTP conversational handshake, data transmission, and quit", async () => {
			const receivedCommands: string[] = [];
			let dataBody = "";

			const server = createServer((socket) => {
				// 1. Initial greeting
				socket.write("220 smtp.mock.local ESMTP MockServer\r\n");

				let inData = false;

				socket.on("data", (chunk) => {
					const lines = chunk.toString("utf8").split("\r\n");
					for (const line of lines) {
						if (!line && !inData) continue;
						if (inData) {
							dataBody += `${line}\r\n`;
							if (line === ".") {
								inData = false;
								socket.write("250 2.0.0 Ok: queued as 12345\r\n");
							}
						} else {
							receivedCommands.push(line);
							if (line.startsWith("EHLO")) {
								socket.write("250-smtp.mock.local\r\n250-AUTH LOGIN\r\n250 8BITMIME\r\n");
							} else if (line.startsWith("AUTH LOGIN")) {
								socket.write("334 VXNlcm5hbWU6\r\n"); // "Username:" in base64
							} else if (line === Buffer.from("alex@company.com").toString("base64")) {
								socket.write("334 UGFzc3dvcmQ6\r\n"); // "Password:" in base64
							} else if (line === Buffer.from("password123").toString("base64")) {
								socket.write("235 2.7.0 Authentication successful\r\n");
							} else if (line.startsWith("MAIL FROM:")) {
								socket.write("250 2.1.0 Ok\r\n");
							} else if (line.startsWith("RCPT TO:")) {
								socket.write("250 2.1.5 Ok\r\n");
							} else if (line === "DATA") {
								inData = true;
								socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
							} else if (line === "QUIT") {
								socket.write("221 2.0.0 Bye\r\n");
								socket.end();
							}
						}
					}
				});
			});

			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
			const port = (server.address() as AddressInfo).port;

			try {
				const client = new SocketSmtpClient({
					host: "127.0.0.1",
					port,
					tls: false,
					user: "alex@company.com",
					password: "password123",
				});

				const result = await client.send({
					from: "alex@company.com",
					to: "recipient@example.com",
					subject: "Test Subject",
					body: "Hello from unit test!\n.leading dot line\nEnd of body",
				});

				expect(result.messageId).toBeDefined();
				expect(receivedCommands).toContain("EHLO localhost");
				expect(receivedCommands).toContain("AUTH LOGIN");
				expect(receivedCommands).toContain("MAIL FROM:<alex@company.com>");
				expect(receivedCommands).toContain("RCPT TO:<recipient@example.com>");
				expect(receivedCommands).toContain("DATA");
				expect(receivedCommands).toContain("QUIT");

				// Check dot-stuffing was applied
				expect(dataBody).toContain("..leading dot line");
			} finally {
				server.close();
			}
		});

		it("rejects when server greeting returns error status code", async () => {
			const server = createServer((socket) => {
				socket.write("421 4.3.2 Service not available, closing transmission channel\r\n");
				socket.end();
			});

			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
			const port = (server.address() as AddressInfo).port;

			try {
				const client = new SocketSmtpClient({
					host: "127.0.0.1",
					port,
					tls: false,
				});

				let error: Error | null = null;
				try {
					await client.send({
						from: "alex@company.com",
						to: "recipient@example.com",
						subject: "Test",
						body: "Test",
					});
				} catch (err: unknown) {
					error = err as Error;
				}

				expect(error).toBeDefined();
				expect(error?.message).toContain("421");
			} finally {
				server.close();
			}
		});

		it("rejects when authentication fails on server", async () => {
			const server = createServer((socket) => {
				socket.write("220 smtp.mock.local ESMTP\r\n");
				socket.on("data", (chunk) => {
					const line = chunk.toString("utf8").trim();
					if (line.startsWith("EHLO")) {
						socket.write("250-smtp.mock.local\r\n250 AUTH LOGIN\r\n");
					} else if (line === "AUTH LOGIN") {
						socket.write("334 VXNlcm5hbWU6\r\n");
					} else if (line === Buffer.from("baduser").toString("base64")) {
						socket.write("334 UGFzc3dvcmQ6\r\n");
					} else {
						socket.write("535 5.7.8 Authentication credentials invalid\r\n");
					}
				});
			});

			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
			const port = (server.address() as AddressInfo).port;

			try {
				const client = new SocketSmtpClient({
					host: "127.0.0.1",
					port,
					tls: false,
					user: "baduser",
					password: "badpassword",
				});

				let error: Error | null = null;
				try {
					await client.send({
						from: "alex@company.com",
						to: "recipient@example.com",
						subject: "Test",
						body: "Test",
					});
				} catch (err: unknown) {
					error = err as Error;
				}

				expect(error).toBeDefined();
				expect(error?.message).toContain("535");
			} finally {
				server.close();
			}
		});

		it("rejects when recipient is rejected by server", async () => {
			const server = createServer((socket) => {
				socket.write("220 smtp.mock.local ESMTP\r\n");
				socket.on("data", (chunk) => {
					const line = chunk.toString("utf8").trim();
					if (line.startsWith("EHLO")) {
						socket.write("250 OK\r\n");
					} else if (line.startsWith("MAIL FROM:")) {
						socket.write("250 2.1.0 Ok\r\n");
					} else if (line.startsWith("RCPT TO:")) {
						socket.write("550 5.1.1 User unknown\r\n");
					}
				});
			});

			await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
			const port = (server.address() as AddressInfo).port;

			try {
				const client = new SocketSmtpClient({
					host: "127.0.0.1",
					port,
					tls: false,
				});

				let error: Error | null = null;
				try {
					await client.send({
						from: "alex@company.com",
						to: "unknown@example.com",
						subject: "Test",
						body: "Test",
					});
				} catch (err: unknown) {
					error = err as Error;
				}

				expect(error).toBeDefined();
				expect(error?.message).toContain("550");
			} finally {
				server.close();
			}
		});
	});
});
