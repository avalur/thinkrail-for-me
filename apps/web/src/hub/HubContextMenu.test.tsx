import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HubContextMenu } from "./HubContextMenu";

describe("HubContextMenu", () => {
	test("renders context menu items with labels", () => {
		const items = [
			{ label: "Показать непрочитанные", action: () => {} },
			{ label: "Отметить прочитанными", action: () => {} },
			{ label: "Синхронизировать", action: () => {} },
		];

		const html = renderToStaticMarkup(
			<HubContextMenu x={150} y={200} onClose={() => {}} items={items} />,
		);

		expect(html).toContain('data-testid="hub-context-menu"');
		expect(html).toContain("Показать непрочитанные");
		expect(html).toContain("Отметить прочитанными");
		expect(html).toContain("Синхронизировать");
		expect(html).toContain('data-testid="hub-context-item-0"');
		expect(html).toContain('data-testid="hub-context-item-1"');
		expect(html).toContain('data-testid="hub-context-item-2"');
	});
});
