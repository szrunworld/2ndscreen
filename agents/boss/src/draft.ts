// Drafts a recruiter's reply with a chat model behind an OpenAI-compatible
// API: Doubao on Volcengine Ark by default.

import OpenAI from 'openai';
import type { Chat } from './chat.ts';

export interface DraftOptions {
  /** What the recruiter wants replies to do, e.g. "先请对方发简历". */
  brief?: string;
  model?: string;
  baseURL?: string;
  apiKey?: string;
}

const SYSTEM = `你是一名招聘者，在 BOSS直聘 上回复候选人。根据职位、候选人资料和对话，写一条回复。
要求：
- 只输出要发送的那条消息本身，不要解释，不要加引号。
- 简短自然，像真人招聘者，一到三句话，不超过 80 个字。
- 不编造职位、薪资、公司或流程的任何细节；资料里没有的，就问或说稍后确认。
- 不承诺录用，不索取身份证号、银行卡等敏感信息。`;

export function prompt(open: Chat, brief?: string): string {
  const c = open.candidate;
  const history = open.messages.map((m) => `${m.from === 'me' ? '我' : '候选人'}：${m.text}`).join('\n');
  return [
    `沟通的职位：${c.position || '未知'}`,
    `候选人：${c.name}，${c.summary}${c.expects ? `，期望 ${c.expects}` : ''}`,
    c.history.length ? `经历：\n${c.history.join('\n')}` : '',
    brief ? `我的回复方针：${brief}` : '',
    `对话：\n${history || '（还没有消息）'}`,
    '请写我接下来要发的一条消息。',
  ].filter(Boolean).join('\n\n');
}

export async function draftReply(open: Chat, options: DraftOptions = {}): Promise<string> {
  const client = new OpenAI({
    baseURL: options.baseURL ?? process.env.ARK_BASE_URL ?? 'https://ark.cn-beijing.volces.com/api/v3',
    apiKey: options.apiKey ?? process.env.ARK_API_KEY,
  });
  const response = await client.chat.completions.create({
    model: options.model ?? process.env.ARK_TEXT_MODEL ?? process.env.ARK_MODEL ?? 'doubao-seed-2-1-lite-260915',
    temperature: 0.3,
    max_tokens: 300,
    // @ts-expect-error Ark's switch for thinking, not in OpenAI's types.
    thinking: { type: 'disabled' },
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: prompt(open, options.brief) },
    ],
  });
  const text = response.choices[0]?.message?.content?.trim() ?? '';
  if (!text) throw new Error('the model returned no reply');
  return text.replace(/^["“「]|["”」]$/g, '').trim();
}
