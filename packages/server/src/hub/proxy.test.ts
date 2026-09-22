import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import zlib from "node:zlib";
import {
	handleProxyRequest,
	resolveTargetUrl,
	rewriteCspForFraming,
	rewriteLocation,
	setCustomTargetResolver,
} from "./proxy";

describe("Hub Reverse-Proxy Gateway", () => {
	let mockServer: ReturnType<typeof Bun.serve>;
	let mockServerUrl: string;

	const testHtmlGzip = zlib.gzipSync(
		Buffer.from(
			"<!DOCTYPE html><html><head><title>App</title></head><body><h1>Web Messenger</h1></body></html>",
		),
	);

	beforeAll(() => {
		mockServer = Bun.serve({
			port: 0,
			fetch(req) {
				const url = new URL(req.url);

				if (url.pathname === "/gzip-html") {
					return new Response(testHtmlGzip, {
						status: 200,
						headers: {
							"Content-Type": "text/html; charset=utf-8",
							"Content-Encoding": "gzip",
							"Content-Length": String(testHtmlGzip.length),
							"X-Frame-Options": "DENY",
							"Content-Security-Policy":
								"default-src 'self'; frame-ancestors 'none'; script-src 'self'",
							"Cross-Origin-Opener-Policy": "same-origin",
							"Cross-Origin-Embedder-Policy": "require-corp",
						},
					});
				}

				if (url.pathname === "/gzip-json") {
					const jsonCompressed = zlib.gzipSync(
						Buffer.from(JSON.stringify({ message: "hello compressed json" })),
					);
					return new Response(jsonCompressed, {
						status: 200,
						headers: {
							"Content-Type": "application/json",
							"Content-Encoding": "gzip",
							"Content-Length": String(jsonCompressed.length),
							"X-Frame-Options": "SAMEORIGIN",
						},
					});
				}

				if (url.pathname === "/plain-asset") {
					const body = "console.log('uncompressed script');";
					return new Response(body, {
						status: 200,
						headers: {
							"Content-Type": "application/javascript",
							"Content-Length": String(Buffer.byteLength(body)),
							"X-Frame-Options": "SAMEORIGIN",
						},
					});
				}

				if (url.pathname === "/redirect") {
					return new Response(null, {
						status: 302,
						headers: {
							Location: "/gzip-html",
							"X-Frame-Options": "DENY",
						},
					});
				}

				if (url.pathname === "/html-no-head") {
					return new Response("<div>No head tag</div>", {
						status: 200,
						headers: { "Content-Type": "text/html" },
					});
				}

				return new Response("Not found", { status: 404 });
			},
		});

		mockServerUrl = `http://localhost:${mockServer.port}`;
	});

	afterAll(() => {
		mockServer.stop();
		setCustomTargetResolver(null);
	});

	describe("Target URL Resolution", () => {
		test("resolves direct ?url= query parameter", () => {
			const req = new URL("http://localhost:24242/proxy?url=https%3A%2F%2Fweb.telegram.org%2Fa");
			const result = resolveTargetUrl(req, new Headers());
			expect(result).not.toBeNull();
			expect(result?.targetUrl.href).toBe("https://web.telegram.org/a");
		});

		test("resolves x-target-url header", () => {
			const req = new URL("http://localhost:24242/proxy");
			const headers = new Headers({ "x-target-url": "https://app.slack.com/client" });
			const result = resolveTargetUrl(req, headers);
			expect(result?.targetUrl.href).toBe("https://app.slack.com/client");
		});

		test("resolves service presets (telegram, slack, discord, whatsapp)", () => {
			const tg = resolveTargetUrl(
				new URL("http://localhost:24242/proxy/telegram/k/?query=1"),
				new Headers(),
			);
			expect(tg?.targetUrl.href).toBe("https://web.telegram.org/k/?query=1");
			expect(tg?.servicePrefix).toBe("telegram");

			const slack = resolveTargetUrl(
				new URL("http://localhost:24242/proxy/slack/client/T1/C1"),
				new Headers(),
			);
			expect(slack?.targetUrl.href).toBe("https://app.slack.com/client/T1/C1");
			expect(slack?.servicePrefix).toBe("slack");
		});

		test("resolves direct embedded URLs in path", () => {
			const direct = resolveTargetUrl(
				new URL("http://localhost:24242/proxy/https://external.example.com/asset.js"),
				new Headers(),
			);
			expect(direct?.targetUrl.href).toBe("https://external.example.com/asset.js");
		});

		test("returns null for unsupported paths or unknown presets", () => {
			expect(resolveTargetUrl(new URL("http://localhost:24242/proxy"), new Headers())).toBeNull();
			expect(
				resolveTargetUrl(new URL("http://localhost:24242/proxy/unknown_svc"), new Headers()),
			).toBeNull();
		});
	});

	describe("CSP Framing Rewrite", () => {
		test("removes frame-ancestors directive while keeping other directives", () => {
			const csp = "default-src 'self'; frame-ancestors 'none'; script-src 'self' 'unsafe-inline'";
			const rewritten = rewriteCspForFraming(csp);
			expect(rewritten).not.toContain("frame-ancestors");
			expect(rewritten).toContain("default-src 'self'");
			expect(rewritten).toContain("script-src 'self' 'unsafe-inline'");
		});

		test("removes frame-ancestors from multiple comma-separated policies (e.g. WhatsApp)", () => {
			const csp =
				"default-src 'self' blob:; block-all-mixed-content; upgrade-insecure-requests; , frame-ancestors https://*.whatsapp.com https://whatsapp.com;";
			const rewritten = rewriteCspForFraming(csp);
			expect(rewritten).not.toBeNull();
			expect(rewritten).not.toContain("frame-ancestors");
			expect(rewritten).toContain("default-src 'self' blob:");
			expect(rewritten).toContain("upgrade-insecure-requests");
		});

		test("returns null if frame-ancestors is the only directive", () => {
			const csp = "frame-ancestors 'self' https://trusted.com";
			expect(rewriteCspForFraming(csp)).toBeNull();
		});
	});

	describe("Location Header Rewrite", () => {
		test("rewrites relative redirect location to stay within proxy preset", () => {
			const targetUrl = new URL("https://web.telegram.org/k/");
			const reqUrl = new URL("http://localhost:24242/proxy/telegram/k/");
			const rewritten = rewriteLocation("/k/login", targetUrl, reqUrl, "telegram");
			expect(rewritten).toBe("/proxy/telegram/k/login");
		});

		test("rewrites external redirect to /proxy?url= parameter", () => {
			const targetUrl = new URL("https://web.telegram.org/");
			const reqUrl = new URL("http://localhost:24242/proxy/telegram");
			const rewritten = rewriteLocation("https://oauth.provider.com/auth", targetUrl, reqUrl);
			expect(rewritten).toBe("/proxy?url=https%3A%2F%2Foauth.provider.com%2Fauth");
		});
	});

	describe("handleProxyRequest Execution & Header / Decompression Fixes", () => {
		test("handles OPTIONS preflight requests with CORS headers", async () => {
			const req = new Request("http://localhost:24242/proxy/telegram", {
				method: "OPTIONS",
				headers: {
					Origin: "http://localhost:24269",
					"Access-Control-Request-Headers": "Authorization, Content-Type",
				},
			});
			const res = await handleProxyRequest(req);
			expect(res.status).toBe(204);
			expect(res.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:24269");
			expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
			expect(res.headers.get("Access-Control-Allow-Headers")).toBe("Authorization, Content-Type");
		});

		test("strips X-Frame-Options, COOP/COEP and rewrites CSP", async () => {
			const target = `${mockServerUrl}/gzip-html`;
			const req = new Request(`http://localhost:24242/proxy?url=${encodeURIComponent(target)}`);
			const res = await handleProxyRequest(req);

			expect(res.status).toBe(200);
			// X-Frame-Options stripped
			expect(res.headers.get("x-frame-options")).toBeNull();
			// COOP / COEP stripped
			expect(res.headers.get("cross-origin-opener-policy")).toBeNull();
			expect(res.headers.get("cross-origin-embedder-policy")).toBeNull();
			// CSP rewritten: frame-ancestors removed, other directives preserved
			const csp = res.headers.get("content-security-policy");
			expect(csp).not.toBeNull();
			expect(csp).not.toContain("frame-ancestors");
			expect(csp).toContain("default-src 'self'");
		});

		test("critical fix: strips content-encoding and invalid content-length when upstream body is decompressed (HTML rewrite)", async () => {
			const target = `${mockServerUrl}/gzip-html`;
			const req = new Request(`http://localhost:24242/proxy?url=${encodeURIComponent(target)}`);
			const res = await handleProxyRequest(req);

			// Upstream sent gzip, but Bun fetch auto-decompressed it.
			// Proxy must strip content-encoding and remove stale compressed content-length!
			expect(res.headers.get("content-encoding")).toBeNull();
			expect(res.headers.get("content-length")).toBeNull();

			// Body should be valid decompressed HTML text
			const text = await res.text();
			expect(text).toContain("Web Messenger");
			// Base tag injected
			expect(text).toContain(`<base href="${target}">`);
		});

		test("critical fix: strips content-encoding and invalid content-length on non-HTML streaming pass-through", async () => {
			const target = `${mockServerUrl}/gzip-json`;
			const req = new Request(`http://localhost:24242/proxy?url=${encodeURIComponent(target)}`);
			const res = await handleProxyRequest(req);

			expect(res.status).toBe(200);
			// Proxy must NOT send content-encoding: gzip for decompressed stream
			expect(res.headers.get("content-encoding")).toBeNull();
			expect(res.headers.get("content-length")).toBeNull();

			// Can parse JSON directly without decompression error
			const json = (await res.json()) as { message: string };
			expect(json.message).toBe("hello compressed json");
		});

		test("preserves content-length for uncompressed assets", async () => {
			const target = `${mockServerUrl}/plain-asset`;
			const req = new Request(`http://localhost:24242/proxy?url=${encodeURIComponent(target)}`);
			const res = await handleProxyRequest(req);

			expect(res.status).toBe(200);
			expect(res.headers.get("content-encoding")).toBeNull();
			// Uncompressed asset preserves its content-length
			expect(res.headers.get("content-length")).not.toBeNull();
			const text = await res.text();
			expect(text).toBe("console.log('uncompressed script');");
		});

		test("rewrites Location header on redirect responses", async () => {
			const target = `${mockServerUrl}/redirect`;
			const req = new Request(`http://localhost:24242/proxy?url=${encodeURIComponent(target)}`);
			const res = await handleProxyRequest(req);

			expect(res.status).toBe(302);
			const loc = res.headers.get("location");
			expect(loc).not.toBeNull();
			expect(loc).toContain("/proxy?url=");
		});

		test("injects base tag even if HTML has no head tag", async () => {
			const target = `${mockServerUrl}/html-no-head`;
			const req = new Request(`http://localhost:24242/proxy?url=${encodeURIComponent(target)}`);
			const res = await handleProxyRequest(req);

			expect(res.status).toBe(200);
			const text = await res.text();
			expect(text).toContain(`<base href="${target}">`);
			expect(text).toContain("<div>No head tag</div>");
		});
	});
});
