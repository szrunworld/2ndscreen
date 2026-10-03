# 2ndscreen-llm

A Cloudflare Worker that lets 2ndscreen's vision agent (`2ndscreen agent`) use Qwen without
the provider key ever leaving Cloudflare. The agent sends its prompt and screenshots to an
OpenAI-compatible `POST /v1/chat/completions` here, and gets the model's next
`Thought: … Action: …` back. It follows remotedesk-it's LLM gateway: the key lives only in
the Worker's secrets, and screenshots go from the user's machine through Cloudflare to the
model and nowhere else.

## What a caller can and cannot do

- **Each user holds a token of their own.** KV keeps only its SHA-256 (`token:<hash>`), so a
  token can be revoked alone and a leaked KV holds nothing usable. Anyone with a user's
  token can still use the Worker until it is revoked; that is the point of making tokens
  per user.
- **A token is good for this one use.** The model (`QWEN_MODEL`, default `qwen3.8-flash`)
  and its settings (temperature 0, thinking off, at most 2,000 output tokens) are fixed here;
  the request's `model` and sampling fields are ignored. Only text and inline
  `data:image/png|jpeg|webp` screenshots are accepted, at most six per request and
  40 MB in all; no image URLs, so the Worker never fetches anything for a caller; no streaming.
- **Rate limit:** 30 requests a minute per user. It is counted per Cloudflare location, so it
  stops abuse rather than metering exactly.
- **Kill switch:** `npm run token -- off` makes every request answer 503 until `on`.
- **Logs** record the user, the model, the image count, token usage, status and latency.
  They never record screenshots, prompts or replies. Provider errors are not passed back
  either, since they can quote the request.

Errors use OpenAI's shape (`{"error": {"message", "type", "code"}}`): 401 missing or unknown
token, 403 revoked, 429 over the rate limit, 400 an invalid request, 503 switched off or
the model busy, 502/504 the model failed or took over 60 s.

## Deploy

Needs a Cloudflare account that can deploy Workers, and the DashScope key (Beijing region,
SSM `/remotedesk/dev/shared/DASHSCOPE_API_KEY`).

```bash
npm install
npx wrangler deploy                 # first deploy also creates the STATE KV namespace
npx wrangler secret put QWEN_API_KEY
npm run token -- create alice       # prints alice's token once
```

Then on alice's machine, in `~/.config/2ndscreen/model.env` (macOS) or
`%USERPROFILE%\.config\2ndscreen\model.env` (Windows):

```
AGENT_MODEL_BASE_URL=https://2ndscreen-llm.<account>.workers.dev/v1
AGENT_MODEL_API_KEY=2s_…
```

`npm run token -- revoke alice` revokes her tokens; `list` shows who has access. Token and
switch changes reach every location within about a minute (KV's cache).

The key's region decides the endpoint: a Beijing key works only with
`dashscope.aliyuncs.com`. Users far from Beijing may do better with an international
(Singapore) key and `QWEN_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1`.

## Develop

```bash
npm test             # vitest in the Workers runtime; stubs the model, never calls it
npm run typecheck
npm run types        # after changing wrangler.jsonc
```

For `wrangler dev`, put `QWEN_API_KEY=…` in `.dev.vars` (ignored by git), and make a local
token with `npm run token -- create me --local`.

npm needs `legacy-peer-deps` (set in `.npmrc`) to install `@cloudflare/vitest-plugin`.
