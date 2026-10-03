// What the Worker keeps in KV. Its own module: a Worker's main module may export only handlers.

/** KV key that, set to "off", turns the Worker off for everyone. */
export const SWITCH_KEY = "switch";

/** KV key holding one token's record: the token itself is never stored, only its SHA-256. */
export async function tokenKey(token: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
	return `token:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
