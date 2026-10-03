import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { SWITCH_KEY, tokenKey } from "../src/state";
import { MAX_COMPLETION_TOKENS, MAX_IMAGES } from "../src/request";

const TOKEN = "2s_test-token";
const PNG = `data:image/png;base64,${btoa("\x89PNG fake screenshot")}`;
const REPLY = "Thought: 点输入框\nAction: click(start_box='[500, 875]')";

function body(images = 1, extra: Record<string, unknown> = {}) {
	return {
		model: "doubao-seed-2-1-lite-260915",
		temperature: 0.9,
		thinking: { type: "disabled" },
		messages: [
			{ role: "user", content: "You are a GUI agent.\n## User Instruction\n点击发送" },
			{ role: "user", content: Array.from({ length: images }, () => ({ type: "image_url", image_url: { url: PNG } })) },
		],
		...extra,
	};
}

async function call(payload: unknown, init: { token?: string | null; method?: string; path?: string } = {}) {
	const headers: Record<string, string> = { "content-type": "application/json" };
	const token = init.token === undefined ? TOKEN : init.token;
	if (token !== null) headers.authorization = `Bearer ${token}`;
	const request = new Request<unknown, IncomingRequestCfProperties>(`https://llm.example${init.path ?? "/v1/chat/completions"}`, {
		method: init.method ?? "POST",
		headers,
		body: init.method === "GET" ? undefined : typeof payload === "string" ? payload : JSON.stringify(payload),
	});
	return worker.fetch(request, env);
}

function upstreamReply(status = 200, payload: unknown = {
	id: "chatcmpl-up",
	created: 1700000000,
	model: "qwen3.8-flash",
	choices: [{ message: { role: "assistant", content: REPLY }, finish_reason: "stop" }],
	usage: { prompt_tokens: 1500, completion_tokens: 40, total_tokens: 1540 },
}) {
	return vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(payload), { status }));
}

beforeEach(async () => {
	await env.STATE.put(await tokenKey(TOKEN), JSON.stringify({ user: "alice" }));
	await env.STATE.delete(SWITCH_KEY);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("tokens", () => {
	it("refuses a request without a token", async () => {
		const response = await call(body(), { token: null });
		expect(response.status).toBe(401);
	});

	it("refuses an unknown token", async () => {
		expect((await call(body(), { token: "2s_someone-else" })).status).toBe(401);
	});

	it("refuses a revoked token", async () => {
		await env.STATE.put(await tokenKey(TOKEN), JSON.stringify({ user: "alice", revoked: true }));
		expect((await call(body())).status).toBe(403);
	});

	it("keeps only the token's hash in KV", async () => {
		const keys = (await env.STATE.list({ prefix: "token:" })).keys.map((key) => key.name);
		expect(keys).toContain(await tokenKey(TOKEN));
		expect(keys.join()).not.toContain(TOKEN);
	});
});

describe("controls", () => {
	it("answers 503 without calling the model when switched off", async () => {
		const upstream = upstreamReply();
		await env.STATE.put(SWITCH_KEY, "off");
		const response = await call(body());
		expect(response.status).toBe(503);
		expect(upstream).not.toHaveBeenCalled();
	});

	it("answers 429 when the user is over the rate limit", async () => {
		const upstream = upstreamReply();
		vi.spyOn(env.PER_USER, "limit").mockResolvedValue({ success: false });
		const response = await call(body());
		expect(response.status).toBe(429);
		expect(response.headers.get("retry-after")).toBe("60");
		expect(upstream).not.toHaveBeenCalled();
	});
});

describe("requests", () => {
	it.each([
		["too many images", body(MAX_IMAGES + 1)],
		["streaming", body(1, { stream: true })],
		["a remote image", { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://10.0.0.1/x.png" } }] }] }],
		["an unknown role", { messages: [{ role: "tool", content: "x" }] }],
		["no messages", { messages: [] }],
		["a body that is not JSON", "{not json"],
	])("refuses %s before calling the model", async (_, payload) => {
		const upstream = upstreamReply();
		const response = await call(payload);
		expect(response.status).toBe(400);
		expect(upstream).not.toHaveBeenCalled();
	});

	it("forwards with the Worker's model and settings, and answers in OpenAI's shape", async () => {
		const upstream = upstreamReply();
		const response = await call(body(2, { max_tokens: 99_999 }));
		expect(response.status).toBe(200);

		const [url, init] = upstream.mock.calls[0];
		expect(String(url)).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
		const headers = new Headers(init?.headers);
		expect(headers.get("authorization")).toBe("Bearer test-provider-key");
		const sent = JSON.parse(String(init?.body));
		expect(sent.model).toBe("qwen3.8-flash");
		expect(sent.temperature).toBe(0);
		expect(sent.enable_thinking).toBe(false);
		expect(sent.max_tokens).toBe(MAX_COMPLETION_TOKENS);
		expect(sent.thinking).toBeUndefined();
		expect(sent.messages[1].content).toHaveLength(2);

		const reply = await response.json<{ object: string; choices: { message: { content: string } }[]; usage: { total_tokens: number } }>();
		expect(reply.object).toBe("chat.completion");
		expect(reply.choices[0].message.content).toBe(REPLY);
		expect(reply.usage.total_tokens).toBe(1540);
	});

	it("logs who and how much, never the screenshots or the prompt", async () => {
		upstreamReply();
		const log = vi.spyOn(console, "log");
		await call(body(2));
		const lines = log.mock.calls.map((args) => String(args[0])).join("\n");
		expect(lines).toContain('"user":"alice"');
		expect(lines).toContain('"images":2');
		expect(lines).not.toContain("base64");
		expect(lines).not.toContain("点击发送");
		expect(lines).not.toContain(REPLY);
	});
});

describe("upstream failures", () => {
	it("passes on a busy model as 503 with a retry hint", async () => {
		upstreamReply(429, { error: { message: "rate limited" } });
		const response = await call(body());
		expect(response.status).toBe(503);
		expect(response.headers.get("retry-after")).toBe("5");
	});

	it("does not echo the provider's error, which can quote the request", async () => {
		upstreamReply(400, { error: { message: `bad image ${PNG}` } });
		const response = await call(body());
		expect(response.status).toBe(502);
		expect(await response.text()).not.toContain("base64");
	});

	it("answers 504 when the model takes too long", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new DOMException("timed out", "TimeoutError"));
		expect((await call(body())).status).toBe(504);
	});

	it("answers 502 when the model returns no text", async () => {
		upstreamReply(200, { choices: [{ message: { content: "  " } }] });
		expect((await call(body())).status).toBe(502);
	});
});

describe("routes", () => {
	it("serves a health check, and nothing else but the completions endpoint", async () => {
		expect((await call(null, { method: "GET", path: "/health", token: null })).status).toBe(200);
		expect((await call(body(), { path: "/v1/embeddings" })).status).toBe(404);
		expect((await call(null, { method: "GET" })).status).toBe(405);
	});
});

describe("the deployed entry point", () => {
	it("loads as the runtime loads it, exporting only handlers", async () => {
		const { exports } = await import("cloudflare:workers");
		const response = await exports.default.fetch("https://llm.example/health");
		expect(response.status).toBe(200);
	});
});
