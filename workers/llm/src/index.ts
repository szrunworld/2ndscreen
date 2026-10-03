// 2ndscreen-llm: lets 2ndscreen's vision agent reach Qwen without the provider key ever
// leaving Cloudflare. An OpenAI-compatible POST /v1/chat/completions: screenshots and the
// agent's prompt in, the model's next "Thought: ... Action: ..." out.
//
// Each caller holds a token of their own, which this Worker knows only by its SHA-256 in KV,
// so a token can be revoked alone and a leaked KV holds nothing usable. The model, its
// settings and the request's shape are fixed here, so a token is good for this one use.
// Screenshots, prompts and replies are never logged or stored.

import { InvalidRequest, MAX_BODY_BYTES, parseRequest, type CompletionRequest } from "./request";
import { SWITCH_KEY, tokenKey } from "./state";

/** KV value behind `token:<sha256 of the token>`. */
interface TokenRecord {
	user: string;
	revoked?: boolean;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json; charset=utf-8", ...headers },
	});
}

/** OpenAI-style error body, which OpenAI-compatible clients show as is. */
function failure(status: number, message: string, code: string, headers: Record<string, string> = {}): Response {
	return json(status, { error: { message, type: code, code } }, headers);
}

async function authenticate(request: Request, env: Env): Promise<TokenRecord | Response> {
	const [scheme, token] = (request.headers.get("authorization") ?? "").split(" ", 2);
	if (scheme?.toLowerCase() !== "bearer" || !token) {
		return failure(401, "send your 2ndscreen token as Authorization: Bearer <token>", "missing_token");
	}
	// Looked up by hash, so no token is ever compared character by character.
	const record = await env.STATE.get<TokenRecord>(await tokenKey(token), "json");
	if (!record || typeof record.user !== "string") return failure(401, "unknown token", "invalid_token");
	if (record.revoked) return failure(403, "this token has been revoked", "revoked_token");
	return record;
}

/** The body as JSON, refusing more than MAX_BODY_BYTES without reading it all first. */
async function readBody(request: Request): Promise<unknown> {
	const declared = Number(request.headers.get("content-length") ?? "0");
	if (declared > MAX_BODY_BYTES) throw new InvalidRequest("the request is too large");
	if (!request.body) throw new InvalidRequest("the request has no body");
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_BODY_BYTES) {
			await reader.cancel();
			throw new InvalidRequest("the request is too large");
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new InvalidRequest("the body is not JSON");
	}
}

interface UpstreamCompletion {
	id?: string;
	created?: number;
	model?: string;
	choices?: { message?: { content?: unknown }; finish_reason?: string }[];
	usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

async function complete(request: CompletionRequest, env: Env): Promise<UpstreamCompletion | Response> {
	const timeout = Number(env.UPSTREAM_TIMEOUT_MS) || 60_000;
	let upstream: Response;
	try {
		upstream = await fetch(`${env.QWEN_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
			method: "POST",
			headers: { authorization: `Bearer ${env.QWEN_API_KEY}`, "content-type": "application/json" },
			body: JSON.stringify({
				model: env.QWEN_MODEL,
				messages: request.messages,
				// The UI-TARS SDK's settings: steady, repeatable actions.
				temperature: 0,
				top_p: 0.7,
				max_tokens: request.maxTokens,
				stream: false,
				// Each step needs a short Thought / Action; thinking only adds cost and delay.
				enable_thinking: false,
			}),
			signal: AbortSignal.timeout(timeout),
		});
	} catch (error) {
		const timedOut = error instanceof Error && error.name === "TimeoutError";
		return failure(timedOut ? 504 : 502, timedOut ? "the model took too long" : "the model could not be reached", "upstream_unavailable");
	}
	if (!upstream.ok) {
		// The provider's own message can echo the request; keep it out of the reply and logs.
		await upstream.body?.cancel();
		const busy = upstream.status === 429;
		return failure(busy ? 503 : 502, busy ? "the model is busy; retry shortly" : `the model failed (${upstream.status})`, "upstream_error", busy ? { "retry-after": "5" } : {});
	}
	try {
		return await upstream.json<UpstreamCompletion>();
	} catch {
		return failure(502, "the model's reply was not JSON", "upstream_error");
	}
}

async function chatCompletions(request: Request, env: Env): Promise<Response> {
	const started = Date.now();
	const caller = await authenticate(request, env);
	if (caller instanceof Response) return caller;

	if ((await env.STATE.get(SWITCH_KEY)) === "off") {
		return failure(503, "2ndscreen's model service is switched off", "switched_off");
	}
	const { success } = await env.PER_USER.limit({ key: caller.user });
	if (!success) return failure(429, "too many requests; wait a minute", "rate_limited", { "retry-after": "60" });
	if (!env.QWEN_API_KEY) return failure(503, "the model service is not configured", "not_configured");

	let parsed: CompletionRequest;
	try {
		parsed = parseRequest(await readBody(request));
	} catch (error) {
		if (error instanceof InvalidRequest) return failure(400, error.message, "invalid_request");
		throw error;
	}

	const result = await complete(parsed, env);
	const log = { event: "completion", user: caller.user, model: env.QWEN_MODEL, images: parsed.images, latency_ms: Date.now() - started };
	if (result instanceof Response) {
		console.log(JSON.stringify({ ...log, status: result.status }));
		return result;
	}
	const choice = result.choices?.[0];
	const content = typeof choice?.message?.content === "string" ? choice.message.content.trim() : "";
	if (!content) {
		console.log(JSON.stringify({ ...log, status: 502 }));
		return failure(502, "the model returned no text", "empty_reply");
	}
	const usage = {
		prompt_tokens: result.usage?.prompt_tokens ?? 0,
		completion_tokens: result.usage?.completion_tokens ?? 0,
		total_tokens: result.usage?.total_tokens ?? 0,
	};
	console.log(JSON.stringify({ ...log, status: 200, ...usage }));
	return json(200, {
		id: result.id ?? `chatcmpl-${crypto.randomUUID()}`,
		object: "chat.completion",
		created: result.created ?? Math.floor(Date.now() / 1000),
		model: result.model ?? env.QWEN_MODEL,
		choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: choice?.finish_reason ?? "stop" }],
		usage,
	});
}

export default {
	async fetch(request, env): Promise<Response> {
		const { pathname } = new URL(request.url);
		try {
			if (pathname === "/v1/chat/completions") {
				if (request.method !== "POST") return failure(405, "use POST", "method_not_allowed", { allow: "POST" });
				return await chatCompletions(request, env);
			}
			if (pathname === "/health" && request.method === "GET") return json(200, { ok: true });
			return failure(404, "not found", "not_found");
		} catch (error) {
			console.error(JSON.stringify({ event: "error", path: pathname, error: error instanceof Error ? error.name : "unknown" }));
			return failure(500, "internal error", "internal_error");
		}
	},
} satisfies ExportedHandler<Env>;
