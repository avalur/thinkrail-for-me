import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { HubMessagesView } from "./HubMessagesView";

describe("HubMessagesView", () => {
	test("renders messages view layout with top bar, channels sidebar, stream pane, and composer", () => {
		const html = renderToStaticMarkup(
			<HubMessagesView initialProvider="whatsapp" initialUnreadOnly={false} />,
		);

		expect(html).toContain('data-testid="hub-messages-view"');
		expect(html).toContain('data-testid="hub-messages-top-bar"');
		expect(html).toContain('data-testid="hub-channels-sidebar"');
		expect(html).toContain('data-testid="hub-messages-resize-handle"');
		expect(html).toContain('data-testid="hub-messages-stream-pane"');
		expect(html).toContain('data-testid="hub-messages-list"');
		expect(html).toContain('data-testid="hub-messages-composer"');
		expect(html).toContain('data-testid="toggle-unread-only-btn"');
		expect(html).toContain('data-testid="mark-all-read-btn"');
		expect(html).toContain('data-testid="send-message-btn"');
	});
});
