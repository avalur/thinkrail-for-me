#!/usr/bin/env bun
import { importDiscordPackage } from "../packages/server/src/hub/discordPackageImporter";

async function main() {
	const args = process.argv.slice(2);
	if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
		console.log(`
Использование:
  bun run scripts/import-discord-package.ts <путь-к-package.zip-или-папке>

Пример:
  bun run scripts/import-discord-package.ts ~/Downloads/package.zip
  bun run scripts/import-discord-package.ts ~/Downloads/package/
`);
		process.exit(1);
	}

	const packagePath = args[0];
	console.log(`Импорт архива Discord из: ${packagePath}...`);

	const res = await importDiscordPackage({
		packagePath,
		accountId: "account_discord",
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
