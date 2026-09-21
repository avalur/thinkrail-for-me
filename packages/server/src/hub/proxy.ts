import { logger } from "../log";

const log = logger("hub:proxy");

export const PROXY_PRESETS: Record<string, string> = {
	telegram: "https://web.telegram.org",
	slack: "https://app.slack.com",
	discord: "https://discord.com",
	whatsapp: "https://web.whatsapp.com",
	mail: "https://mail.google.com",
	email: "https://mail.google.com",
};

let customTargetResolver: ((service: string) => string | undefined) | null = null;

export function setCustomTargetResolver(
	resolver: ((service: string) => string | undefined) | null,
): void {
	customTargetResolver = resolver;
}

const HOP_BY_HOP_HEADERS = new Set([
	"connection",
	"keep-alive",
	"proxy-authenticate",
	"proxy-authorization",
	"te",
	"trailers",
	"transfer-encoding",
	"upgrade",
	"host",
]);

export function rewriteCspForFraming(csp: string): string | null {
	const directives = csp
		.split(";")
		.map((d) => d.trim())
		.filter(Boolean);

	const filtered = directives.filter((d) => !d.toLowerCase().startsWith("frame-ancestors"));

	return filtered.length > 0 ? filtered.join("; ") : null;
}

export function rewriteLocation(
	location: string,
	targetUrl: URL,
	_reqUrl: URL,
	servicePrefix?: string,
): string {
	let resolved: URL;
	try {
		resolved = new URL(location, targetUrl);
	} catch {
		return location;
	}

	if (servicePrefix && resolved.origin === targetUrl.origin) {
		const search = resolved.search;
		return `/proxy/${servicePrefix}${resolved.pathname}${search}`;
	}

	return `/proxy?url=${encodeURIComponent(resolved.href)}`;
}

export function resolveTargetUrl(
	reqUrl: URL,
	headers: Headers,
): { targetUrl: URL; servicePrefix?: string } | null {
	// 1. Direct query param: ?url=...
	const queryUrl = reqUrl.searchParams.get("url");
	if (queryUrl) {
		try {
			return { targetUrl: new URL(queryUrl) };
		} catch {
			return null;
		}
	}

	// 2. Custom header: x-target-url
	const headerUrl = headers.get("x-target-url");
	if (headerUrl) {
		try {
			return { targetUrl: new URL(headerUrl) };
		} catch {
			return null;
		}
	}

	const pathname = reqUrl.pathname;
	if (pathname === "/proxy" || pathname === "/proxy/") {
		return null;
	}

	if (pathname.startsWith("/proxy/")) {
		const rest = pathname.slice("/proxy/".length);

		// Direct URL embedded in path: /proxy/https://... or /proxy/https:/...
		if (rest.startsWith("http://") || rest.startsWith("https://")) {
			try {
				return { targetUrl: new URL(rest + reqUrl.search) };
			} catch {
				return null;
			}
		}
		if (rest.startsWith("http:/") && !rest.startsWith("http://")) {
			try {
				return { targetUrl: new URL(rest.replace(/^http:\/?/, "http://") + reqUrl.search) };
			} catch {
				return null;
			}
		}
		if (rest.startsWith("https:/") && !rest.startsWith("https://")) {
			try {
				return { targetUrl: new URL(rest.replace(/^https:\/?/, "https://") + reqUrl.search) };
			} catch {
				return null;
			}
		}

		// Service preset: /proxy/telegram/k/...
		const slashIndex = rest.indexOf("/");
		const service = slashIndex === -1 ? rest : rest.slice(0, slashIndex);
		const subpath = slashIndex === -1 ? "" : rest.slice(slashIndex);

		const serviceKey = service.toLowerCase();
		const customBase = customTargetResolver?.(serviceKey);
		const presetBase = customBase ?? PROXY_PRESETS[serviceKey];

		if (presetBase) {
			try {
				const fullUrl = new URL(subpath + reqUrl.search, presetBase);
				return { targetUrl: fullUrl, servicePrefix: serviceKey };
			} catch {
				return null;
			}
		}
	}

	return null;
}

export async function handleProxyRequest(req: Request): Promise<Response> {
	const reqUrl = new URL(req.url);

	// CORS Preflight
	if (req.method === "OPTIONS") {
		return new Response(null, {
			status: 204,
			headers: {
				"Access-Control-Allow-Origin": req.headers.get("origin") ?? "*",
				"Access-Control-Allow-Methods": "GET, HEAD, POST, PUT, DELETE, PATCH, OPTIONS",
				"Access-Control-Allow-Headers": req.headers.get("access-control-request-headers") ?? "*",
				"Access-Control-Allow-Credentials": "true",
				"Access-Control-Max-Age": "86400",
			},
		});
	}

	const resolution = resolveTargetUrl(reqUrl, req.headers);

	if (!resolution) {
		if (reqUrl.pathname === "/proxy" || reqUrl.pathname === "/proxy/") {
			return new Response(
				JSON.stringify({
					status: "ok",
					service: "thinkrail-hub-proxy",
					presets: Object.keys(PROXY_PRESETS),
				}),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			);
		}
		return new Response(
			JSON.stringify({
				error: "Invalid proxy target URL or unknown service preset",
				path: reqUrl.pathname,
				availablePresets: Object.keys(PROXY_PRESETS),
			}),
			{
				status: 400,
				headers: { "Content-Type": "application/json" },
			},
		);
	}

	const { targetUrl, servicePrefix } = resolution;

	// Build upstream headers
	const forwardHeaders = new Headers();
	for (const [key, value] of req.headers.entries()) {
		const lower = key.toLowerCase();
		if (
			HOP_BY_HOP_HEADERS.has(lower) ||
			lower.startsWith("cf-") ||
			lower === "x-forwarded-for" ||
			lower === "x-target-url"
		) {
			continue;
		}
		forwardHeaders.set(key, value);
	}

	forwardHeaders.set("Host", targetUrl.host);
	if (forwardHeaders.has("origin")) {
		forwardHeaders.set("origin", targetUrl.origin);
	}
	if (forwardHeaders.has("referer")) {
		forwardHeaders.set("referer", targetUrl.href);
	}

	let upstreamResponse: Response;
	try {
		const isBodyAllowed = req.method !== "GET" && req.method !== "HEAD";
		upstreamResponse = await fetch(targetUrl.href, {
			method: req.method,
			headers: forwardHeaders,
			body: isBodyAllowed ? req.body : undefined,
			redirect: "manual",
			// @ts-expect-error duplex is valid in Bun/Node fetch with streaming body
			duplex: isBodyAllowed && req.body ? "half" : undefined,
		});
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		log.warn(`proxy upstream error for ${targetUrl.href}: ${message}`);
		return new Response(
			JSON.stringify({
				error: "Proxy upstream request failed",
				target: targetUrl.href,
				message,
			}),
			{
				status: 502,
				headers: { "Content-Type": "application/json" },
			},
		);
	}

	// Build client response headers
	const responseHeaders = new Headers();
	for (const [key, value] of upstreamResponse.headers.entries()) {
		const lower = key.toLowerCase();
		if (HOP_BY_HOP_HEADERS.has(lower)) continue;

		// 1. Strip X-Frame-Options
		if (lower === "x-frame-options") continue;

		// 2. Rewrite CSP to strip frame-ancestors
		if (lower === "content-security-policy" || lower === "content-security-policy-report-only") {
			const rewritten = rewriteCspForFraming(value);
			if (rewritten) {
				responseHeaders.set(key, rewritten);
			}
			continue;
		}

		// 3. Strip isolation headers that break iframe embedding
		if (lower === "cross-origin-opener-policy" || lower === "cross-origin-embedder-policy") {
			continue;
		}

		// 4. Strip content-encoding because Bun fetch automatically decompresses bodies
		if (lower === "content-encoding") {
			continue;
		}

		// 5. Rewrite Location header on redirects
		if (lower === "location") {
			responseHeaders.set("Location", rewriteLocation(value, targetUrl, reqUrl, servicePrefix));
			continue;
		}

		responseHeaders.set(key, value);
	}

	// If upstream used content-encoding (gzip, br, deflate), Bun fetch decompressed the body,
	// so upstream content-length is invalid for the forwarded uncompressed stream.
	if (upstreamResponse.headers.has("content-encoding")) {
		responseHeaders.delete("content-length");
	}

	// Add CORS headers
	const origin = req.headers.get("origin") ?? "*";
	responseHeaders.set("Access-Control-Allow-Origin", origin);
	responseHeaders.set("Access-Control-Allow-Credentials", "true");
	responseHeaders.set(
		"Access-Control-Allow-Methods",
		"GET, HEAD, POST, PUT, DELETE, PATCH, OPTIONS",
	);

	// Handle HTML base tag injection
	const contentType = upstreamResponse.headers.get("content-type") ?? "";
	if (contentType.toLowerCase().includes("text/html")) {
		try {
			let text = await upstreamResponse.text();
			if (!/<base\s/i.test(text)) {
				const baseTag = `<base href="${targetUrl.href}">`;
				if (/<head[^>]*>/i.test(text)) {
					text = text.replace(/(<head[^>]*>)/i, `$1\n  ${baseTag}`);
				} else {
					text = `${baseTag}\n${text}`;
				}
			}
			// Delete Content-Length since body length might have changed
			responseHeaders.delete("content-length");
			return new Response(text, {
				status: upstreamResponse.status,
				statusText: upstreamResponse.statusText,
				headers: responseHeaders,
			});
		} catch {
			// Fallback to streaming if text parsing fails
		}
	}

	return new Response(upstreamResponse.body, {
		status: upstreamResponse.status,
		statusText: upstreamResponse.statusText,
		headers: responseHeaders,
	});
}
