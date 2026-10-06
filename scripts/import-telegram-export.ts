#!/usr/bin/env bun
import { importTelegramExport } from "../packages/server/src/hub/telegramExportImporter";

async function main() {
	const args = process.argv.slice(2);
	if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
		console.log(`
Использование:
  bun run scripts/import-telegram-export.ts <путь-к-result.json-или-папке-или-zip>

Пример:
  bun run scripts/import-telegram-export.ts ~/Downloads/TelegramExport/result.json
  bun run scripts/import-telegram-export.ts ~/Downloads/DataExport_2026-09-22/
  bun run scripts/import-telegram-export.ts ~/Downloads/TelegramData.zip
`);
		process.exit(1);
	}

	const exportPath = args[0];
	console.log(`Импорт экспорта Telegram из: ${exportPath}...`);

	const res = await importTelegramExport({
		exportPath,
		accountId: "account_telegram",
	});

	if (res.success) {
		console.log(`
Успешно импортировано!
- Каналов и чатов: ${res.importedChannels}
- Сообщений: ${res.importedMessages}
Все данные сохранены в локальную базу данных SQLite (~/.thinkrail/hub.sqlite) и проиндексированы для поиска FTS5.
`);
	} else {
		console.error(`Ошибка при импорте: ${res.error}`);
		process.exit(1);
	}
}

main().catch((err) => {
	console.error("Непредвиденная ошибка:", err);
	process.exit(1);
});
