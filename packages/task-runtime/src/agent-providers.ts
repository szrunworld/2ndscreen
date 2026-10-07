// Providers the host calls on an agent's behalf (RFC 0001 §6). The key
// lives in the host's environment and goes only to the configured base URL:
// redirects are refused, so a server cannot carry it elsewhere. Agents only
// ever see the answer.
//
// openai-chat: the OpenAI-compatible chat completions API that Volcengine
// Ark (Doubao), DashScope (Qwen) and others serve. Input is a string (one
// user message) or { messages, maxTokens?, temperature? }; output is
// { text }.

import type { ProviderConfig } from './agent-config.ts';
import type { ProviderService } from './agent-host.ts';
import { RuntimeError } from './contracts.ts';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_MESSAGES = 64;
const MAX_CHARS = 200_000;

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

function messagesOf(input: unknown): { messages: ChatMessage[]; maxTokens?: number; temperature?: number } {
  if (typeof input === 'string') return { messages: [{ role: 'user', content: input }] };
  const o = input as { messages?: unknown; maxTokens?: unknown; temperature?: unknown } | null;
  if (typeof o !== 'object' || o === null || !Array.isArray(o.messages) || o.messages.length === 0 || o.messages.length > MAX_MESSAGES)
    throw new RuntimeError('invalid_input', 'provider input must be a string or { messages: [{ role, content }] }');
  const messages = o.messages.map((m) => {
    const x = m as Partial<ChatMessage> | null;
    if (!x || !['system', 'user', 'assistant'].includes(x.role as string) || typeof x.content !== 'string')
      throw new RuntimeError('invalid_input', 'each message needs a role (system, user or assistant) and string content');
    return { role: x.role!, content: x.content };
  });
  if (messages.reduce((n, m) => n + m.content.length, 0) > MAX_CHARS) throw new RuntimeError('invalid_input', 'provider input is too long');
  return {
    messages,
    ...(Number.isInteger(o.maxTokens) && (o.maxTokens as number) > 0 && { maxTokens: o.maxTokens as number }),
    ...(typeof o.temperature === 'number' && o.temperature >= 0 && o.temperature <= 2 && { temperature: o.temperature }),
  };
}

export interface ProviderServiceOptions {
  providers: Record<string, ProviderConfig>;
  /** Where keys are read from; default process.env. */
  env?: Readonly<Record<string, string | undefined>>;
  fetch?: typeof fetch;
}

export function createProviderService(options: ProviderServiceOptions): ProviderService {
  const env = options.env ?? process.env;
  const doFetch = options.fetch ?? fetch;
  return {
    async call(request, signal) {
      const cfg = options.providers[request.providerId];
      if (!cfg) throw new RuntimeError('model_unavailable', `provider ${request.providerId} is not configured on this machine`);
      const key = env[cfg.apiKeyEnv];
      if (!key) throw new RuntimeError('model_unavailable', `${cfg.apiKeyEnv} is not set for provider ${request.providerId}`);
      const body = messagesOf(request.input);
      const url = new URL('chat/completions', cfg.baseUrl.endsWith('/') ? cfg.baseUrl : `${cfg.baseUrl}/`);
      const timeout = AbortSignal.timeout(cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      let response: Response;
      try {
        response = await doFetch(url, {
          method: 'POST',
          redirect: 'error',
          signal: AbortSignal.any([signal, timeout]),
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model: cfg.model,
            messages: body.messages,
            ...(body.maxTokens !== undefined && { max_tokens: body.maxTokens }),
            ...(body.temperature !== undefined && { temperature: body.temperature }),
          }),
        });
      } catch {
        if (signal.aborted) throw new RuntimeError('cancelled', 'the provider call was cancelled');
        throw new RuntimeError('model_unavailable', `provider ${request.providerId} could not be reached`);
      }
      if (!response.ok) {
        // The body may echo the request; it is not passed on.
        await response.body?.cancel().catch(() => undefined);
        const unavailable = response.status === 429 || response.status >= 500;
        throw new RuntimeError(unavailable ? 'model_unavailable' : 'io', `provider ${request.providerId} answered ${response.status}`);
      }
      let json: { model?: unknown; choices?: Array<{ message?: { content?: unknown } }>; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
      try {
        json = (await response.json()) as typeof json;
      } catch {
        throw new RuntimeError('io', `provider ${request.providerId} answered something that is not JSON`);
      }
      const text = json.choices?.[0]?.message?.content;
      if (typeof text !== 'string') throw new RuntimeError('io', `provider ${request.providerId} answered without a message`);
      const tokens = (n: unknown) => (Number.isInteger(n) && (n as number) >= 0 ? (n as number) : ('unknown' as const));
      return {
        output: { text },
        usage: { inputTokens: tokens(json.usage?.prompt_tokens), outputTokens: tokens(json.usage?.completion_tokens) },
        model: typeof json.model === 'string' && json.model !== '' ? json.model : cfg.model,
      };
    },
  };
}
