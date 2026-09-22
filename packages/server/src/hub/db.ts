import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
	HubAccount,
	HubAccountProvider,
	HubAccountStatus,
	HubAccountSummary,
	HubAgentTask,
	HubAgentTaskStatus,
	HubChannel,
	HubChannelKind,
	HubDashboardSummary,
	HubFilter,
	HubMarkReadParams,
	HubMessage,
} from "@thinkrail/contracts";
import { dataDir } from "../persistence";

export const DEFAULT_ACCOUNTS: ReadonlyArray<Omit<HubAccount, "unreadCount" | "lastSyncAt">> = [
	{ id: "account_telegram", provider: "telegram", name: "Telegram", status: "disconnected" },
	{ id: "account_email_work", provider: "email_work", name: "Work Email", status: "disconnected" },
	{
		id: "account_email_personal",
		provider: "email_personal",
		name: "Personal Email",
		status: "disconnected",
	},
	{ id: "account_slack", provider: "slack", name: "Slack", status: "disconnected" },
	{ id: "account_discord", provider: "discord", name: "Discord", status: "disconnected" },
	{ id: "account_whatsapp", provider: "whatsapp", name: "WhatsApp", status: "disconnected" },
];

let defaultDbInstance: Database | null = null;
let customDbPath: string | null = null;

export function getHubDbPath(): string {
	if (customDbPath) return customDbPath;
	return join(dataDir(), "hub.sqlite");
}

export function setHubDbPath(path: string | null): void {
	if (defaultDbInstance) {
		defaultDbInstance.close();
		defaultDbInstance = null;
	}
	customDbPath = path;
}

export function setHubDbForTesting(db: Database | null): void {
	if (defaultDbInstance && defaultDbInstance !== db) {
		defaultDbInstance.close();
	}
	defaultDbInstance = db;
}

export function getHubDb(path?: string): Database {
	if (path) {
		if (path !== ":memory:") {
			mkdirSync(dirname(path), { recursive: true });
		}
		const db = new Database(path);
		configureAndInitDb(db);
		return db;
	}

	if (!defaultDbInstance) {
		const dbPath = getHubDbPath();
		if (dbPath !== ":memory:") {
			mkdirSync(dirname(dbPath), { recursive: true });
		}
		defaultDbInstance = new Database(dbPath);
		configureAndInitDb(defaultDbInstance);
	}

	return defaultDbInstance;
}

export function closeHubDb(db?: Database): void {
	if (db) {
		if (db === defaultDbInstance) {
			defaultDbInstance = null;
		}
		db.close();
		return;
	}

	if (defaultDbInstance) {
		defaultDbInstance.close();
		defaultDbInstance = null;
	}
}

function configureAndInitDb(db: Database): void {
	db.run("PRAGMA journal_mode = WAL;");
	db.run("PRAGMA foreign_keys = ON;");
	db.run("PRAGMA busy_timeout = 5000;");
	initHubSchema(db);
}

export function initHubSchema(db: Database): void {
	db.run(`
		CREATE TABLE IF NOT EXISTS hub_migrations (
			version INTEGER PRIMARY KEY,
			applied_at INTEGER NOT NULL
		);
	`);

	const row = db.query("SELECT MAX(version) as ver FROM hub_migrations;").get() as {
		ver: number | null;
	} | null;
	const currentVersion = row?.ver ?? 0;

	if (currentVersion < 1) {
		db.run(`
			CREATE TABLE IF NOT EXISTS hub_accounts (
				id TEXT PRIMARY KEY,
				provider TEXT NOT NULL,
				name TEXT NOT NULL,
				email TEXT,
				status TEXT NOT NULL,
				unread_count INTEGER DEFAULT 0,
				last_sync_at INTEGER,
				error TEXT,
				metadata TEXT
			);

			CREATE TABLE IF NOT EXISTS hub_channels (
				id TEXT PRIMARY KEY,
				account_id TEXT NOT NULL,
				remote_id TEXT NOT NULL,
				name TEXT NOT NULL,
				kind TEXT,
				unread_count INTEGER DEFAULT 0,
				last_message_at INTEGER,
				metadata TEXT,
				FOREIGN KEY(account_id) REFERENCES hub_accounts(id) ON DELETE CASCADE
			);

			CREATE TABLE IF NOT EXISTS hub_messages (
				id TEXT PRIMARY KEY,
				account_id TEXT NOT NULL,
				remote_id TEXT NOT NULL,
				channel_id TEXT,
				sender_name TEXT NOT NULL,
				sender_address TEXT NOT NULL,
				recipient_address TEXT,
				subject TEXT,
				body TEXT NOT NULL,
				snippet TEXT NOT NULL,
				timestamp INTEGER NOT NULL,
				is_read INTEGER DEFAULT 0,
				is_urgent INTEGER DEFAULT 0,
				has_attachments INTEGER DEFAULT 0,
				attachments TEXT,
				metadata TEXT,
				FOREIGN KEY(account_id) REFERENCES hub_accounts(id) ON DELETE CASCADE,
				FOREIGN KEY(channel_id) REFERENCES hub_channels(id) ON DELETE SET NULL
			);

			CREATE INDEX IF NOT EXISTS idx_hub_messages_timestamp ON hub_messages(timestamp DESC);
			CREATE INDEX IF NOT EXISTS idx_hub_messages_account ON hub_messages(account_id, is_read);
			CREATE INDEX IF NOT EXISTS idx_hub_messages_channel ON hub_messages(channel_id, is_read);
			CREATE INDEX IF NOT EXISTS idx_hub_messages_urgent ON hub_messages(is_urgent, is_read);
			CREATE INDEX IF NOT EXISTS idx_hub_channels_account ON hub_channels(account_id);

			CREATE TABLE IF NOT EXISTS hub_agent_tasks (
				id TEXT PRIMARY KEY,
				title TEXT NOT NULL,
				description TEXT,
				status TEXT NOT NULL,
				source_message_id TEXT,
				source_account_id TEXT,
				suggested_action TEXT,
				created_at INTEGER NOT NULL,
				completed_at INTEGER,
				metadata TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_hub_agent_tasks_status ON hub_agent_tasks(status);

			CREATE VIRTUAL TABLE IF NOT EXISTS hub_messages_fts USING fts5(
				id UNINDEXED,
				subject,
				body,
				sender_name,
				sender_address,
				content="hub_messages",
				content_rowid="rowid"
			);

			CREATE TRIGGER IF NOT EXISTS hub_messages_ai AFTER INSERT ON hub_messages BEGIN
				INSERT INTO hub_messages_fts(rowid, id, subject, body, sender_name, sender_address)
				VALUES (new.rowid, new.id, new.subject, new.body, new.sender_name, new.sender_address);
			END;

			CREATE TRIGGER IF NOT EXISTS hub_messages_ad AFTER DELETE ON hub_messages BEGIN
				INSERT INTO hub_messages_fts(hub_messages_fts, rowid, id, subject, body, sender_name, sender_address)
				VALUES('delete', old.rowid, old.id, old.subject, old.body, old.sender_name, old.sender_address);
			END;

			CREATE TRIGGER IF NOT EXISTS hub_messages_au AFTER UPDATE OF subject, body, sender_name, sender_address ON hub_messages BEGIN
				INSERT INTO hub_messages_fts(hub_messages_fts, rowid, id, subject, body, sender_name, sender_address)
				VALUES('delete', old.rowid, old.id, old.subject, old.body, old.sender_name, old.sender_address);
				INSERT INTO hub_messages_fts(rowid, id, subject, body, sender_name, sender_address)
				VALUES (new.rowid, new.id, new.subject, new.body, new.sender_name, new.sender_address);
			END;
		`);

		db.run("INSERT INTO hub_migrations (version, applied_at) VALUES (1, ?);", [Date.now()]);
	}

	if (currentVersion < 2) {
		db.run(`
			CREATE UNIQUE INDEX IF NOT EXISTS idx_hub_messages_account_remote ON hub_messages(account_id, remote_id);
		`);
		db.run("INSERT INTO hub_migrations (version, applied_at) VALUES (2, ?);", [Date.now()]);
	}
}

export const initHubDb = initHubSchema;

// ---------------------------------------------------------------------------
// Row conversion helpers
// ---------------------------------------------------------------------------

interface AccountRow {
	id: string;
	provider: string;
	name: string;
	email: string | null;
	status: string;
	unread_count: number;
	last_sync_at: number | null;
	error: string | null;
	metadata: string | null;
}

function fromAccountRow(row: AccountRow): HubAccount {
	return {
		id: row.id,
		provider: row.provider as HubAccountProvider,
		name: row.name,
		...(row.email ? { email: row.email } : {}),
		status: row.status as HubAccountStatus,
		unreadCount: row.unread_count,
		lastSyncAt: row.last_sync_at,
		...(row.error ? { error: row.error } : {}),
		...(row.metadata ? { metadata: JSON.parse(row.metadata) } : {}),
	};
}

interface ChannelRow {
	id: string;
	account_id: string;
	remote_id: string;
	name: string;
	kind: string | null;
	unread_count: number;
	last_message_at: number | null;
	metadata: string | null;
}

function fromChannelRow(row: ChannelRow): HubChannel {
	return {
		id: row.id,
		accountId: row.account_id,
		remoteId: row.remote_id,
		name: row.name,
		...(row.kind ? { kind: row.kind as HubChannelKind } : {}),
		unreadCount: row.unread_count,
		lastMessageAt: row.last_message_at,
		...(row.metadata ? { metadata: JSON.parse(row.metadata) } : {}),
	};
}

interface MessageRow {
	id: string;
	account_id: string;
	remote_id: string;
	channel_id: string | null;
	sender_name: string;
	sender_address: string;
	recipient_address: string | null;
	subject: string | null;
	body: string;
	snippet: string;
	timestamp: number;
	is_read: number;
	is_urgent: number;
	has_attachments: number;
	attachments: string | null;
	metadata: string | null;
}

function fromMessageRow(row: MessageRow): HubMessage {
	return {
		id: row.id,
		accountId: row.account_id,
		remoteId: row.remote_id,
		...(row.channel_id ? { channelId: row.channel_id } : {}),
		senderName: row.sender_name,
		senderAddress: row.sender_address,
		...(row.recipient_address ? { recipientAddress: row.recipient_address } : {}),
		...(row.subject ? { subject: row.subject } : {}),
		body: row.body,
		snippet: row.snippet,
		timestamp: row.timestamp,
		isRead: row.is_read === 1,
		isUrgent: row.is_urgent === 1,
		hasAttachments: row.has_attachments === 1,
		...(row.attachments ? { attachments: JSON.parse(row.attachments) } : {}),
		...(row.metadata ? { metadata: JSON.parse(row.metadata) } : {}),
	};
}

interface AgentTaskRow {
	id: string;
	title: string;
	description: string | null;
	status: string;
	source_message_id: string | null;
	source_account_id: string | null;
	suggested_action: string | null;
	created_at: number;
	completed_at: number | null;
	metadata: string | null;
}

function fromAgentTaskRow(row: AgentTaskRow): HubAgentTask {
	return {
		id: row.id,
		title: row.title,
		...(row.description ? { description: row.description } : {}),
		status: row.status as HubAgentTaskStatus,
		...(row.source_message_id ? { sourceMessageId: row.source_message_id } : {}),
		...(row.source_account_id ? { sourceAccountId: row.source_account_id } : {}),
		...(row.suggested_action ? { suggestedAction: row.suggested_action } : {}),
		createdAt: row.created_at,
		...(row.completed_at ? { completedAt: row.completed_at } : {}),
		...(row.metadata ? { metadata: JSON.parse(row.metadata) } : {}),
	};
}

// ---------------------------------------------------------------------------
// Account CRUD
// ---------------------------------------------------------------------------

export function saveAccount(account: HubAccount, database?: Database): void {
	const db = database ?? getHubDb();
	const sql = `
		INSERT INTO hub_accounts (id, provider, name, email, status, unread_count, last_sync_at, error, metadata)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			provider = excluded.provider,
			name = excluded.name,
			email = excluded.email,
			status = excluded.status,
			unread_count = excluded.unread_count,
			last_sync_at = excluded.last_sync_at,
			error = excluded.error,
			metadata = excluded.metadata;
	`;
	db.run(sql, [
		account.id,
		account.provider,
		account.name,
		account.email ?? null,
		account.status,
		account.unreadCount ?? 0,
		account.lastSyncAt ?? null,
		account.error ?? null,
		account.metadata ? JSON.stringify(account.metadata) : null,
	]);
}

export function getAccount(id: string, database?: Database): HubAccount | null {
	const db = database ?? getHubDb();
	const row = db.query("SELECT * FROM hub_accounts WHERE id = ?;").get(id) as AccountRow | null;
	return row ? fromAccountRow(row) : null;
}

export function getAccounts(provider?: HubAccountProvider, database?: Database): HubAccount[] {
	const db = database ?? getHubDb();
	if (provider) {
		const rows = db
			.query("SELECT * FROM hub_accounts WHERE provider = ? ORDER BY name ASC;")
			.all(provider) as AccountRow[];
		return rows.map(fromAccountRow);
	}
	const rows = db.query("SELECT * FROM hub_accounts ORDER BY name ASC;").all() as AccountRow[];
	return rows.map(fromAccountRow);
}

export function deleteAccount(id: string, database?: Database): boolean {
	const db = database ?? getHubDb();
	const info = db.run("DELETE FROM hub_accounts WHERE id = ?;", [id]);
	return info.changes > 0;
}

export function updateAccountStatus(
	id: string,
	status: HubAccountStatus,
	unreadCount?: number,
	error?: string | null,
	database?: Database,
	metadata?: Record<string, unknown>,
): void {
	const db = database ?? getHubDb();
	const metaStr = metadata !== undefined ? JSON.stringify(metadata) : null;
	if (unreadCount !== undefined) {
		if (metaStr !== null) {
			db.run(
				"UPDATE hub_accounts SET status = ?, unread_count = ?, error = ?, last_sync_at = ?, metadata = ? WHERE id = ?;",
				[status, unreadCount, error ?? null, Date.now(), metaStr, id],
			);
		} else {
			db.run(
				"UPDATE hub_accounts SET status = ?, unread_count = ?, error = ?, last_sync_at = ? WHERE id = ?;",
				[status, unreadCount, error ?? null, Date.now(), id],
			);
		}
	} else {
		if (metaStr !== null) {
			db.run("UPDATE hub_accounts SET status = ?, error = ?, metadata = ? WHERE id = ?;", [
				status,
				error ?? null,
				metaStr,
				id,
			]);
		} else {
			db.run("UPDATE hub_accounts SET status = ?, error = ? WHERE id = ?;", [
				status,
				error ?? null,
				id,
			]);
		}
	}
}

export function seedDefaultAccountsIfEmpty(database?: Database): HubAccount[] {
	const db = database ?? getHubDb();
	const existing = getAccounts(undefined, db);
	if (existing.length > 0) return existing;

	for (const acc of DEFAULT_ACCOUNTS) {
		saveAccount(
			{
				...acc,
				unreadCount: 0,
				lastSyncAt: null,
			},
			db,
		);
	}
	return getAccounts(undefined, db);
}

// ---------------------------------------------------------------------------
// Channel CRUD
// ---------------------------------------------------------------------------

export function saveChannel(channel: HubChannel, database?: Database): void {
	const db = database ?? getHubDb();
	const sql = `
		INSERT INTO hub_channels (id, account_id, remote_id, name, kind, unread_count, last_message_at, metadata)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			account_id = excluded.account_id,
			remote_id = excluded.remote_id,
			name = excluded.name,
			kind = excluded.kind,
			unread_count = excluded.unread_count,
			last_message_at = excluded.last_message_at,
			metadata = excluded.metadata;
	`;
	db.run(sql, [
		channel.id,
		channel.accountId,
		channel.remoteId,
		channel.name,
		channel.kind ?? null,
		channel.unreadCount ?? 0,
		channel.lastMessageAt ?? null,
		channel.metadata ? JSON.stringify(channel.metadata) : null,
	]);
}

export function getChannel(id: string, database?: Database): HubChannel | null {
	const db = database ?? getHubDb();
	const row = db.query("SELECT * FROM hub_channels WHERE id = ?;").get(id) as ChannelRow | null;
	return row ? fromChannelRow(row) : null;
}

export function getChannels(accountId?: string, database?: Database): HubChannel[] {
	const db = database ?? getHubDb();
	if (accountId) {
		const rows = db
			.query(
				"SELECT * FROM hub_channels WHERE account_id = ? ORDER BY last_message_at DESC, name ASC;",
			)
			.all(accountId) as ChannelRow[];
		return rows.map(fromChannelRow);
	}
	const rows = db
		.query("SELECT * FROM hub_channels ORDER BY last_message_at DESC, name ASC;")
		.all() as ChannelRow[];
	return rows.map(fromChannelRow);
}

export function deleteChannel(id: string, database?: Database): boolean {
	const db = database ?? getHubDb();
	const info = db.run("DELETE FROM hub_channels WHERE id = ?;", [id]);
	return info.changes > 0;
}

// ---------------------------------------------------------------------------
// Message CRUD & Query
// ---------------------------------------------------------------------------

function sanitizeFtsQuery(query: string): string {
	const words = query
		.split(/\s+/)
		.map((w) => w.replace(/["'*()]/g, "").trim())
		.filter((w) => w.length > 0);
	if (words.length === 0) return "";
	return words.map((w) => `"${w}"*`).join(" ");
}

export function saveMessage(message: HubMessage, database?: Database): void {
	const db = database ?? getHubDb();
	const sql = `
		INSERT INTO hub_messages (
			id, account_id, remote_id, channel_id, sender_name, sender_address,
			recipient_address, subject, body, snippet, timestamp,
			is_read, is_urgent, has_attachments, attachments, metadata
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			account_id = excluded.account_id,
			remote_id = excluded.remote_id,
			channel_id = excluded.channel_id,
			sender_name = excluded.sender_name,
			sender_address = excluded.sender_address,
			recipient_address = excluded.recipient_address,
			subject = excluded.subject,
			body = excluded.body,
			snippet = excluded.snippet,
			timestamp = excluded.timestamp,
			is_read = excluded.is_read,
			is_urgent = excluded.is_urgent,
			has_attachments = excluded.has_attachments,
			attachments = excluded.attachments,
			metadata = excluded.metadata;
	`;
	db.run(sql, [
		message.id,
		message.accountId,
		message.remoteId,
		message.channelId ?? null,
		message.senderName,
		message.senderAddress,
		message.recipientAddress ?? null,
		message.subject ?? null,
		message.body,
		message.snippet,
		message.timestamp,
		message.isRead ? 1 : 0,
		message.isUrgent ? 1 : 0,
		message.hasAttachments ? 1 : 0,
		message.attachments ? JSON.stringify(message.attachments) : null,
		message.metadata ? JSON.stringify(message.metadata) : null,
	]);

	// Update account unread count & sync time
	db.run(
		`
		UPDATE hub_accounts
		SET unread_count = (SELECT COUNT(*) FROM hub_messages WHERE hub_messages.account_id = hub_accounts.id AND is_read = 0),
		    last_sync_at = MAX(COALESCE(last_sync_at, 0), ?)
		WHERE id = ?;
		`,
		[message.timestamp, message.accountId],
	);

	if (message.channelId) {
		db.run(
			`
			UPDATE hub_channels
			SET unread_count = (SELECT COUNT(*) FROM hub_messages WHERE hub_messages.channel_id = hub_channels.id AND is_read = 0),
			    last_message_at = MAX(COALESCE(last_message_at, 0), ?)
			WHERE id = ?;
			`,
			[message.timestamp, message.channelId],
		);
	}
}

export function saveMessages(messages: HubMessage[], database?: Database): void {
	const db = database ?? getHubDb();
	db.transaction(() => {
		for (const msg of messages) {
			saveMessage(msg, db);
		}
	})();
}

export function getMessage(id: string, database?: Database): HubMessage | null {
	const db = database ?? getHubDb();
	const row = db.query("SELECT * FROM hub_messages WHERE id = ?;").get(id) as MessageRow | null;
	return row ? fromMessageRow(row) : null;
}

export function getMessageByRemoteId(
	accountId: string,
	remoteId: string,
	database?: Database,
): HubMessage | null {
	const db = database ?? getHubDb();
	const row = db
		.query("SELECT * FROM hub_messages WHERE account_id = ? AND remote_id = ? LIMIT 1;")
		.get(accountId, remoteId) as MessageRow | null;
	return row ? fromMessageRow(row) : null;
}

export function saveIncomingMessage(
	message: Omit<HubMessage, "id"> & { id?: string },
	options: { preserveLocalReadStatus?: boolean } = { preserveLocalReadStatus: true },
	database?: Database,
): { message: HubMessage; isNew: boolean } {
	const db = database ?? getHubDb();
	const existing = getMessageByRemoteId(message.accountId, message.remoteId, db);
	const id = existing?.id ?? message.id ?? randomUUID();
	const isRead =
		options.preserveLocalReadStatus && existing !== null ? existing.isRead : message.isRead;

	const fullMessage: HubMessage = {
		...message,
		id,
		isRead,
		...(existing?.metadata || message.metadata
			? {
					metadata: {
						...(existing?.metadata ?? {}),
						...(message.metadata ?? {}),
					},
				}
			: {}),
	};

	saveMessage(fullMessage, db);
	return { message: fullMessage, isNew: existing === null };
}

export function saveIncomingMessages(
	messages: Array<Omit<HubMessage, "id"> & { id?: string }>,
	options: { preserveLocalReadStatus?: boolean } = { preserveLocalReadStatus: true },
	database?: Database,
): { inserted: HubMessage[]; updated: HubMessage[] } {
	const db = database ?? getHubDb();
	const inserted: HubMessage[] = [];
	const updated: HubMessage[] = [];

	db.transaction(() => {
		for (const msg of messages) {
			const res = saveIncomingMessage(msg, options, db);
			if (res.isNew) {
				inserted.push(res.message);
			} else {
				updated.push(res.message);
			}
		}
	})();

	return { inserted, updated };
}

export function detectMessageUrgency(
	subject?: string,
	body?: string,
	headers?: Record<string, string>,
): boolean {
	if (headers) {
		const priority = (headers["x-priority"] ?? headers.priority ?? "").toLowerCase();
		if (
			priority.includes("1") ||
			priority.includes("2") ||
			priority.includes("high") ||
			priority.includes("urgent")
		) {
			return true;
		}
		const importance = (headers.importance ?? "").toLowerCase();
		if (importance.includes("high") || importance.includes("urgent")) {
			return true;
		}
	}

	const text = `${subject ?? ""} ${body ?? ""}`.toLowerCase();
	const urgentPatterns = [
		/\burgent\b/,
		/\basap\b/,
		/\bemergency\b/,
		/\baction required\b/,
		/\bimmediate attention\b/,
		/\bdeadline\b/,
		/\bcritical\b/,
	];

	return urgentPatterns.some((pattern) => pattern.test(text));
}

export function generateMessageSnippet(body: string, maxLength = 150): string {
	const stripped = body
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (stripped.length <= maxLength) return stripped;
	return `${stripped.slice(0, maxLength).trimEnd()}...`;
}

export function getMessages(
	filter: HubFilter = {},
	database?: Database,
): { messages: HubMessage[]; total: number; hasMore: boolean } {
	const db = database ?? getHubDb();
	const conditions: string[] = [];
	const params: (string | number)[] = [];

	let joinClause = "";
	if (filter.provider) {
		joinClause = "JOIN hub_accounts a ON m.account_id = a.id";
		conditions.push("a.provider = ?");
		params.push(filter.provider);
	}

	if (filter.accountId) {
		conditions.push("m.account_id = ?");
		params.push(filter.accountId);
	}

	if (filter.channelId) {
		conditions.push("m.channel_id = ?");
		params.push(filter.channelId);
	}

	if (filter.isRead !== undefined) {
		conditions.push("m.is_read = ?");
		params.push(filter.isRead ? 1 : 0);
	}

	if (filter.isUrgent !== undefined) {
		conditions.push("m.is_urgent = ?");
		params.push(filter.isUrgent ? 1 : 0);
	}

	if (filter.since !== undefined) {
		conditions.push("m.timestamp >= ?");
		params.push(filter.since);
	}

	if (filter.query && filter.query.trim().length > 0) {
		const rawQuery = filter.query.trim();
		const sanitized = sanitizeFtsQuery(rawQuery);
		if (sanitized) {
			try {
				conditions.push("m.id IN (SELECT id FROM hub_messages_fts WHERE hub_messages_fts MATCH ?)");
				params.push(sanitized);
			} catch {
				conditions.push(
					"(m.subject LIKE ? OR m.body LIKE ? OR m.sender_name LIKE ? OR m.sender_address LIKE ?)",
				);
				const likePattern = `%${rawQuery}%`;
				params.push(likePattern, likePattern, likePattern, likePattern);
			}
		}
	}

	const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

	const countSql = `SELECT COUNT(*) as count FROM hub_messages m ${joinClause} ${whereClause};`;
	const totalRow = db.query(countSql).get(...params) as { count: number } | null;
	const total = totalRow?.count ?? 0;

	const limit = Math.max(1, Math.min(filter.limit ?? 50, 500));
	const offset = Math.max(0, filter.offset ?? 0);

	const querySql = `
		SELECT m.* FROM hub_messages m
		${joinClause}
		${whereClause}
		ORDER BY m.timestamp DESC
		LIMIT ? OFFSET ?;
	`;

	const rows = db.query(querySql).all(...params, limit, offset) as MessageRow[];
	const messages = rows.map(fromMessageRow);

	return {
		messages,
		total,
		hasMore: offset + messages.length < total,
	};
}

export function markMessagesRead(params: HubMarkReadParams, database?: Database): number {
	const db = database ?? getHubDb();
	const conditions: string[] = ["is_read = 0"];
	const queryParams: (string | number)[] = [];

	if (params.all) {
		if (params.accountId) {
			conditions.push("account_id = ?");
			queryParams.push(params.accountId);
		} else if (params.channelId) {
			conditions.push("channel_id = ?");
			queryParams.push(params.channelId);
		} else if (params.provider) {
			conditions.push("account_id IN (SELECT id FROM hub_accounts WHERE provider = ?)");
			queryParams.push(params.provider);
		}
	} else if (params.messageIds && params.messageIds.length > 0) {
		const placeholders = params.messageIds.map(() => "?").join(",");
		conditions.push(`id IN (${placeholders})`);
		queryParams.push(...params.messageIds);
	} else if (params.accountId) {
		conditions.push("account_id = ?");
		queryParams.push(params.accountId);
	} else if (params.channelId) {
		conditions.push("channel_id = ?");
		queryParams.push(params.channelId);
	} else if (params.provider) {
		conditions.push("account_id IN (SELECT id FROM hub_accounts WHERE provider = ?)");
		queryParams.push(params.provider);
	} else {
		return 0;
	}

	const whereClause = `WHERE ${conditions.join(" AND ")}`;
	const countRow = db
		.query(`SELECT COUNT(*) as count FROM hub_messages ${whereClause};`)
		.get(...queryParams) as { count: number } | null;
	const modifiedCount = countRow?.count ?? 0;

	if (modifiedCount > 0) {
		db.run(`UPDATE hub_messages SET is_read = 1 ${whereClause};`, queryParams);
		recalculateUnreadCounts(db);
	}

	return modifiedCount;
}

export function deleteMessage(id: string, database?: Database): boolean {
	const db = database ?? getHubDb();
	const msg = getMessage(id, db);
	if (!msg) return false;

	const info = db.run("DELETE FROM hub_messages WHERE id = ?;", [id]);
	if (info.changes > 0) {
		recalculateUnreadCounts(db);
		return true;
	}
	return false;
}

export function recalculateUnreadCounts(database?: Database): void {
	const db = database ?? getHubDb();
	db.run(`
		UPDATE hub_accounts
		SET unread_count = (
			SELECT COUNT(*) FROM hub_messages
			WHERE hub_messages.account_id = hub_accounts.id AND is_read = 0
		);
	`);
	db.run(`
		UPDATE hub_channels
		SET unread_count = (
			SELECT COUNT(*) FROM hub_messages
			WHERE hub_messages.channel_id = hub_channels.id AND is_read = 0
		);
	`);
}

// ---------------------------------------------------------------------------
// Agent Tasks CRUD
// ---------------------------------------------------------------------------

export function saveAgentTask(task: HubAgentTask, database?: Database): void {
	const db = database ?? getHubDb();
	const sql = `
		INSERT INTO hub_agent_tasks (
			id, title, description, status, source_message_id, source_account_id,
			suggested_action, created_at, completed_at, metadata
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			title = excluded.title,
			description = excluded.description,
			status = excluded.status,
			source_message_id = excluded.source_message_id,
			source_account_id = excluded.source_account_id,
			suggested_action = excluded.suggested_action,
			created_at = excluded.created_at,
			completed_at = excluded.completed_at,
			metadata = excluded.metadata;
	`;
	db.run(sql, [
		task.id,
		task.title,
		task.description ?? null,
		task.status,
		task.sourceMessageId ?? null,
		task.sourceAccountId ?? null,
		task.suggestedAction ?? null,
		task.createdAt,
		task.completedAt ?? null,
		task.metadata ? JSON.stringify(task.metadata) : null,
	]);
}

export function getAgentTask(id: string, database?: Database): HubAgentTask | null {
	const db = database ?? getHubDb();
	const row = db
		.query("SELECT * FROM hub_agent_tasks WHERE id = ?;")
		.get(id) as AgentTaskRow | null;
	return row ? fromAgentTaskRow(row) : null;
}

export function getAgentTasks(status?: HubAgentTaskStatus, database?: Database): HubAgentTask[] {
	const db = database ?? getHubDb();
	if (status) {
		const rows = db
			.query("SELECT * FROM hub_agent_tasks WHERE status = ? ORDER BY created_at DESC;")
			.all(status) as AgentTaskRow[];
		return rows.map(fromAgentTaskRow);
	}
	const rows = db
		.query("SELECT * FROM hub_agent_tasks ORDER BY created_at DESC;")
		.all() as AgentTaskRow[];
	return rows.map(fromAgentTaskRow);
}

export function updateAgentTaskStatus(
	id: string,
	status: HubAgentTaskStatus,
	completedAtOrDb?: number | Database,
	database?: Database,
): void {
	let completedAt: number | undefined;
	let db: Database;
	if (typeof completedAtOrDb === "number") {
		completedAt = completedAtOrDb;
		db = database ?? getHubDb();
	} else if (completedAtOrDb && typeof completedAtOrDb === "object") {
		completedAt = undefined;
		db = completedAtOrDb;
	} else {
		completedAt = undefined;
		db = database ?? getHubDb();
	}

	db.run("UPDATE hub_agent_tasks SET status = ?, completed_at = ? WHERE id = ?;", [
		status,
		completedAt ?? (status === "completed" ? Date.now() : null),
		id,
	]);
}

export function deleteAgentTask(id: string, database?: Database): boolean {
	const db = database ?? getHubDb();
	const info = db.run("DELETE FROM hub_agent_tasks WHERE id = ?;", [id]);
	return info.changes > 0;
}

// ---------------------------------------------------------------------------
// Dashboard Summary
// ---------------------------------------------------------------------------

export function getDashboardSummary(database?: Database): HubDashboardSummary {
	const db = database ?? getHubDb();

	const unreadRow = db
		.query("SELECT COUNT(*) as count FROM hub_messages WHERE is_read = 0;")
		.get() as { count: number } | null;
	const totalUnread = unreadRow?.count ?? 0;

	const accountsList = getAccounts(undefined, db);
	const accounts: HubAccountSummary[] = accountsList.map((a) => ({
		id: a.id,
		provider: a.provider,
		name: a.name,
		...(a.email ? { email: a.email } : {}),
		status: a.status,
		unreadCount: a.unreadCount,
		lastSyncAt: a.lastSyncAt,
	}));

	const urgentRows = db
		.query(
			"SELECT * FROM hub_messages WHERE is_urgent = 1 AND is_read = 0 ORDER BY timestamp DESC LIMIT 10;",
		)
		.all() as MessageRow[];
	const urgentMessages = urgentRows.map(fromMessageRow);

	const recentRows = db
		.query("SELECT * FROM hub_messages ORDER BY timestamp DESC LIMIT 15;")
		.all() as MessageRow[];
	const recentActivity = recentRows.map(fromMessageRow);

	const activeAgentTasks = getAgentTasks(undefined, db).filter(
		(t) => t.status === "pending" || t.status === "running",
	);

	const suggestedAgentTasks: string[] = [];
	if (urgentMessages.length > 0) {
		suggestedAgentTasks.push(`Triage urgent unread messages (${urgentMessages.length})`);
	}
	suggestedAgentTasks.push("Summarize unread messages from today");
	suggestedAgentTasks.push("Draft daily standup update based on recent discussions");
	suggestedAgentTasks.push("Review and extract action items from communications");

	return {
		totalUnread,
		accounts,
		urgentMessages,
		recentActivity,
		suggestedAgentTasks,
		activeAgentTasks,
	};
}
