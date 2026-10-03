// What a caller may ask for: a subset of OpenAI chat completions, checked before anything
// reaches the model. Only text and inline `data:` images: the Worker never fetches a URL on
// a caller's behalf. Fields such as `model` and `temperature` are accepted and ignored,
// since the model and its settings are chosen here.

/** Screenshots per request. 2ndscreen sends at most the latest five. */
export const MAX_IMAGES = 6;
/** One screenshot's data URL (about 9 MB of image). */
export const MAX_IMAGE_URL_CHARS = 12_000_000;
/** A whole request body. */
export const MAX_BODY_BYTES = 40_000_000;
/** Reply length cap: each step answers with a short Thought / Action. */
export const MAX_COMPLETION_TOKENS = 2_000;
export const DEFAULT_COMPLETION_TOKENS = 1_000;

const MAX_MESSAGES = 64;
const MAX_TEXT_CHARS = 50_000;
const DATA_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=\s]+$/;
const ROLES = new Set(["system", "user", "assistant"]);

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
	role: "system" | "user" | "assistant";
	content: string | ContentPart[];
}

export interface CompletionRequest {
	messages: ChatMessage[];
	maxTokens: number;
	images: number;
}

export class InvalidRequest extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function part(raw: unknown): ContentPart {
	if (!isRecord(raw)) throw new InvalidRequest("each content part must be an object");
	if (raw.type === "text") {
		if (typeof raw.text !== "string" || raw.text.length > MAX_TEXT_CHARS) {
			throw new InvalidRequest(`a text part needs text of at most ${MAX_TEXT_CHARS} characters`);
		}
		return { type: "text", text: raw.text };
	}
	if (raw.type === "image_url") {
		const url = isRecord(raw.image_url) ? raw.image_url.url : undefined;
		if (typeof url !== "string" || url.length > MAX_IMAGE_URL_CHARS || !DATA_URL.test(url)) {
			throw new InvalidRequest("only inline data:image/png|jpeg|webp;base64 images of at most 12 MB are accepted");
		}
		return { type: "image_url", image_url: { url } };
	}
	throw new InvalidRequest("content parts must be text or image_url");
}

function message(raw: unknown): ChatMessage {
	if (!isRecord(raw) || typeof raw.role !== "string" || !ROLES.has(raw.role)) {
		throw new InvalidRequest("each message needs a role of system, user or assistant");
	}
	const role = raw.role as ChatMessage["role"];
	if (typeof raw.content === "string") {
		if (raw.content.length > MAX_TEXT_CHARS) throw new InvalidRequest(`a message is at most ${MAX_TEXT_CHARS} characters`);
		return { role, content: raw.content };
	}
	if (Array.isArray(raw.content) && raw.content.length > 0) return { role, content: raw.content.map(part) };
	throw new InvalidRequest("a message's content must be text or a list of parts");
}

/** Check a parsed request body and keep only what is forwarded. */
export function parseRequest(body: unknown): CompletionRequest {
	if (!isRecord(body)) throw new InvalidRequest("the body must be a JSON object");
	if (body.stream === true) throw new InvalidRequest("streaming is not supported");
	if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > MAX_MESSAGES) {
		throw new InvalidRequest(`messages must be a list of 1 to ${MAX_MESSAGES}`);
	}
	const messages = body.messages.map(message);
	const images = messages.reduce(
		(count, m) => count + (typeof m.content === "string" ? 0 : m.content.filter((p) => p.type === "image_url").length),
		0,
	);
	if (images > MAX_IMAGES) throw new InvalidRequest(`at most ${MAX_IMAGES} images per request`);

	let maxTokens = DEFAULT_COMPLETION_TOKENS;
	if (body.max_tokens !== undefined && body.max_tokens !== null) {
		if (typeof body.max_tokens !== "number" || !Number.isInteger(body.max_tokens) || body.max_tokens < 1) {
			throw new InvalidRequest("max_tokens must be a positive integer");
		}
		maxTokens = Math.min(body.max_tokens, MAX_COMPLETION_TOKENS);
	}
	return { messages, maxTokens, images };
}
