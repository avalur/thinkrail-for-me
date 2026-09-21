---
id: submodule-server-hub
type: submodule-design
status: active
title: hub — personal agent control panel store and reverse-proxy
parent: module-server
depends-on: [module-contracts, submodule-server-persistence, submodule-server-log]
tags: [v1, hub]
---

## Responsibility

Durable SQLite store (`~/.thinkrail/hub.sqlite`) for personal communications (accounts, messages, channels, agent tasks), HTTP reverse-proxy gateway (`/proxy/*`) stripping framing restrictions for embedded web clients, secure credential configuration (`~/.thinkrail/hub-accounts.json`), ingestion connectors for Email and Telegram, periodic polling coordinator, Personal Hub AI agent tools, and personal assistant skill.

## Boundary

- **Owns:**
  - SQLite database initialization, schema migrations, and full-text search indexing (`hub_messages_fts` using SQLite FTS5) under `dataDir()`.
  - CRUD operations and queries for `HubAccount`, `HubChannel`, `HubMessage`, and `HubAgentTask`.
  - Aggregated dashboard summary calculations (`HubDashboardSummary`).
  - Transparent HTTP reverse-proxy handler (`handleProxyRequest`) stripping `X-Frame-Options` and adjusting `Content-Security-Policy` (`frame-ancestors`) to allow safe `<iframe>` embedding of web messaging and webmail clients.
  - Secure credential and account configuration management under `~/.thinkrail/hub-accounts.json` with strict 0600 mode.
  - Ingestion connectors for Email (IMAP synchronization & SMTP dispatching) and Telegram (Bot API / MTProto updates & replies).
  - Background polling coordinator managing periodic sync intervals and concurrency guards.
  - WebSocket RPC handlers for `hub.*` methods (`hub.getAccounts`, `hub.getMessages`, `hub.getDashboardSummary`, `hub.markRead`, `hub.sendMessage`, `hub.syncNow`).
  - Push event publishers for `hub.messageReceived`, `hub.accountStatusChanged`, and `hub.syncStatus`.
  - AI agent tools for Pi runtime (`hub_list_unread`, `hub_search_messages`, `hub_send_email`, `hub_send_telegram`, `hub_summarize_inbox`, and `hubToolsExtension`).
  - Personal Hub skill instructions (`skill/SKILL.md`) for communications triage, daily briefings, and task extraction.
- **Public surface (barrel):** `index.ts` re-exporting database operations, proxy handler, RPC handlers, accounts configuration, email/telegram connectors, polling coordinator, publisher registry, and agent tools.
- **Allowed deps:** `@thinkrail/contracts`, `../persistence` (`dataDir`), `../log`, `bun:sqlite`, Node `crypto`/`fs`/`path`/`net`/`tls`, `@earendil-works/pi-coding-agent`, `typebox`.
- **Forbidden:** importing `web`, `cli`, `desktop`, or circular imports into `host`.

## Schema

- `hub_migrations`: tracks applied schema migration versions.
- `hub_accounts`: registered communication accounts (Telegram, Work Email, Personal Email, Slack, Discord, WhatsApp).
- `hub_channels`: conversations, folders, or threads belonging to an account.
- `hub_messages`: normalized messages with full-text search indexing via `hub_messages_fts` and sync triggers.
- `hub_agent_tasks`: agent-extracted action items and triage cards.
