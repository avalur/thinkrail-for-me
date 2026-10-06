#!/usr/bin/env bun
import {
	type DiscordAccountConfig,
	getAccountConfig,
	saveAccountConfig,
	syncAccountsFromConfigToDb,
} from "../packages/server/src/hub/accounts";
import { DiscordConnector } from "../packages/server/src/hub/connectors/discord";
import {
	getChannels,
	getHubDb,
	getMessages,
	seedDefaultAccountsIfEmpty,
} from "../packages/server/src/hub/db";

interface CliOptions {
	token?: string;
	guildId?: string;
	channelIds?: string[];
	limit: number;
	saveConfig: boolean;
	help: boolean;
}

function parseArgs(args: string[]): CliOptions {
	const options: CliOptions = {
		limit: 1000,
		saveConfig: false,
		help: false,
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "-h" || arg === "--help") {
			options.help = true;
		} else if (arg === "-t" || arg === "--token") {
			options.token = args[++i];
		} else if (arg === "-g" || arg === "--guild") {
			options.guildId = args[++i];
		} else if (arg === "-c" || arg === "--channels") {
			const val = args[++i];
			if (val) {
				options.channelIds = val
					.split(",")
					.map((s) => s.trim())
					.filter(Boolean);
			}
		} else if (arg === "-l" || arg === "--limit") {
			const val = parseInt(args[++i], 10);
			if (!Number.isNaN(val) && val > 0) {
				options.limit = val;
			}
		} else if (arg === "--save-config") {
			options.saveConfig = true;
		}
	}

	return options;
}

function printUsage() {
	console.log(`
Использование:
  bun run scripts/download-discord-messages.ts [опции]

Опции:
  -t, --token <TOKEN>       Токен авторизации Discord-бота (если не передан, берется из ~/.thinkrail/hub-accounts.json или переменной DISCORD_BOT_TOKEN)
  -g, --guild <GUILD_ID>    ID сервера (Guild ID) для выгрузки всех его текстовых каналов (опционально)
  -c, --channels <IDS>      ID каналов через запятую, например: 123456789,987654321 (опционально)
  -l, --limit <NUMBER>      Максимальное количество сообщений на каждый канал (по умолчанию: 1000, укажите больше для глубокого архива)
  --save-config             Сохранить токен и настройки в ~/.thinkrail/hub-accounts.json для веб-панели ThinkRail
  -h, --help                Показать справку

Примеры:
  # Выгрузка с токеном напрямую:
  bun run scripts/download-discord-messages.ts --token "MTA..." --save-config

  # Выгрузка конкретного сервера и ограничение до 5000 сообщений на канал:
  bun run scripts/download-discord-messages.ts --token "MTA..." --guild "123456789012345678" --limit 5000

  # Выгрузка по уже сохраненному в панели токену:
  bun run scripts/download-discord-messages.ts
`);
}

async function verifyToken(
	token: string,
): Promise<{ id: string; username: string; global_name?: string } | null> {
	try {
		const res = await fetch("https://discord.com/api/v10/users/@me", {
			headers: {
				Authorization: `Bot ${token}`,
				"User-Agent": "ThinkRail-Hub/1.0",
			},
		});
		if (!res.ok) {
			return null;
		}
		return (await res.json()) as { id: string; username: string; global_name?: string };
	} catch {
		return null;
	}
}

async function getBotGuilds(token: string): Promise<Array<{ id: string; name: string }>> {
	try {
		const res = await fetch("https://discord.com/api/v10/users/@me/guilds", {
			headers: {
				Authorization: `Bot ${token}`,
				"User-Agent": "ThinkRail-Hub/1.0",
			},
		});
		if (!res.ok) {
			return [];
		}
		return (await res.json()) as Array<{ id: string; name: string }>;
	} catch {
		return [];
	}
}

async function main() {
	const args = process.argv.slice(2);
	const opts = parseArgs(args);

	if (opts.help) {
		printUsage();
		process.exit(0);
	}

	const db = getHubDb();
	seedDefaultAccountsIfEmpty(db);

	// Try resolving token
	let token = opts.token?.trim();
	const existingConfig = getAccountConfig("account_discord") as DiscordAccountConfig | undefined;

	if (!token) {
		// biome-ignore lint/suspicious/noUndeclaredEnvVars: standalone CLI script
		token = process.env.DISCORD_BOT_TOKEN?.trim();
	}

	if (!token && existingConfig?.botToken) {
		token = existingConfig.botToken.trim();
		console.log("ℹ️  Используется токен из ~/.thinkrail/hub-accounts.json");
	}

	if (!token) {
		console.error("❌ Ошибка: Токен бота Discord не указан.");
		console.error(
			'Укажите флаг --token "YOUR_BOT_TOKEN" или настройте учетную запись в веб-интерфейсе.',
		);
		printUsage();
		process.exit(1);
	}

	console.log("🔄 Проверка токена бота Discord...");
	const botUser = await verifyToken(token);
	if (!botUser) {
		console.error("❌ Ошибка авторизации: Discord вернул ошибку при проверке токена.");
		console.error("Убедитесь, что токен указан корректно и скопирован без лишних пробелов.");
		process.exit(1);
	}

	console.log(`✅ Авторизован как бот: @${botUser.username} (ID: ${botUser.id})`);

	const botGuilds = await getBotGuilds(token);
	if (botGuilds.length > 0) {
		console.log(`🌐 Доступные серверы бота (${botGuilds.length}):`);
		for (const g of botGuilds) {
			console.log(`   • ${g.name} (ID: ${g.id})`);
		}
	} else {
		console.warn("⚠️  Внимание: Бот пока не добавлен ни на один сервер Discord.");
	}

	let guildId = opts.guildId?.trim() || existingConfig?.guildId;
	if (
		guildId === "123456789" ||
		(guildId && botGuilds.length > 0 && !botGuilds.some((g) => g.id === guildId))
	) {
		console.warn(`⚠️  Сервер с ID "${guildId}" не найден среди доступных серверов бота.`);
		if (botGuilds.length === 1) {
			const fallbackGuild = botGuilds[0];
			if (fallbackGuild) {
				guildId = fallbackGuild.id;
				console.log(
					`ℹ️  Автоматически выбран единственный доступный сервер: "${fallbackGuild.name}" (ID: ${guildId})`,
				);
			}
		}
	} else if (!guildId && botGuilds.length === 1) {
		const singleGuild = botGuilds[0];
		if (singleGuild) {
			guildId = singleGuild.id;
			console.log(`ℹ️  Автоматически выбран сервер: "${singleGuild.name}" (ID: ${guildId})`);
		}
	}

	const channelIds =
		opts.channelIds && opts.channelIds.length > 0 ? opts.channelIds : existingConfig?.channelIds;

	if (opts.saveConfig || !existingConfig?.botToken || existingConfig?.guildId !== guildId) {
		const updatedConfig: DiscordAccountConfig = {
			id: "account_discord",
			provider: "discord",
			name: botUser.global_name || botUser.username || "Discord",
			enabled: true,
			botToken: token,
			...(guildId ? { guildId } : {}),
			...(channelIds && channelIds.length > 0 ? { channelIds } : {}),
		};
		saveAccountConfig(updatedConfig);
		syncAccountsFromConfigToDb(db);
		console.log("💾 Настройки сохранены в ~/.thinkrail/hub-accounts.json");
	}

	const discordConfig: DiscordAccountConfig = {
		id: "account_discord",
		provider: "discord",
		name: botUser.global_name || botUser.username || "Discord",
		enabled: true,
		botToken: token,
		...(guildId ? { guildId } : {}),
		...(channelIds && channelIds.length > 0 ? { channelIds } : {}),
	};

	console.log(`📥 Начинается скачивание сообщений (лимит на канал: ${opts.limit})...`);
	const connector = new DiscordConnector(discordConfig);

	try {
		const initialMessages = getMessages({ accountId: "account_discord" }, db).total;

		const syncResult = await connector.sync(
			{
				force: true,
				backfill: true,
				backfillLimit: opts.limit,
			},
			db,
		);

		if (syncResult.error) {
			console.error(`\n❌ Ошибка при выгрузке сообщений: ${syncResult.error}`);
			console.error(
				"Убедитесь, что бот приглашен на нужный сервер и имеет права 'View Channels' и 'Read Message History'.",
			);
			process.exit(1);
		}

		const totalChannels = getChannels("account_discord", db);
		const allMessages = getMessages({ accountId: "account_discord" }, db);
		const newlyAdded = allMessages.total - initialMessages;

		console.log(`
🎉 Выгрузка сообщений успешно завершена!
--------------------------------------------------
• Обработано каналов: ${totalChannels.length}
• Загружено новых сообщений: ${newlyAdded > 0 ? newlyAdded : syncResult.syncedCount}
• Всего сообщений в локальной базе: ${allMessages.total}
• Непрочитанных сообщений: ${syncResult.unreadCount}
• База данных: ~/.thinkrail/hub.sqlite
--------------------------------------------------
Все сообщения сохранены в локальную базу данных и доступны для поиска FTS5 и анализа ассистентом в веб-панели ThinkRail!
`);
	} finally {
		connector.stop();
	}
	process.exit(0);
}

main().catch((err) => {
	console.error("Непредвиденная ошибка при выгрузке:", err);
	process.exit(1);
});
