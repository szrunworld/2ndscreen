// A vision model behind an OpenAI-compatible API (Doubao on Volcengine Ark by
// default), for the parts of the screen text recognition cannot settle:
// answering a question about a screenshot, or finding a control by its look.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import OpenAI from 'openai';
import type { Shot } from './screen.ts';

export interface ModelConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

/**
 * From the environment, then ~/.config/2ndscreen/model.env and ark.env for
 * anything unset: the same files the 2ndscreen agent reads.
 */
export function modelConfig(): ModelConfig | undefined {
  const values: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const name of ['model.env', 'ark.env']) {
    let text: string;
    try {
      text = readFileSync(join(homedir(), '.config/2ndscreen', name), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (line.startsWith('#') || !line.includes('=')) continue;
      const [key, ...rest] = line.split('=');
      const value = rest.join('=').trim().replace(/^["']|["']$/g, '');
      if (value && !values[key.trim()]) values[key.trim()] = value;
    }
  }
  const apiKey = values.AGENT_MODEL_API_KEY || values.ARK_API_KEY;
  if (!apiKey) return undefined;
  return {
    apiKey,
    baseURL: values.AGENT_MODEL_BASE_URL || values.ARK_BASE_URL || 'https://ark.cn-beijing.volces.com/api/v3',
    model: values.AGENT_MODEL || values.ARK_MODEL || 'doubao-seed-2-1-lite-260915',
  };
}

export class Vision {
  private client: OpenAI;

  constructor(readonly config: ModelConfig) {
    this.client = new OpenAI({ baseURL: config.baseURL, apiKey: config.apiKey });
  }

  private async complete(shot: Shot, prompt: string, maxTokens = 400): Promise<string> {
    const png = readFileSync(shot.path).toString('base64');
    const response = await this.client.chat.completions.create({
      model: this.config.model,
      temperature: 0,
      max_tokens: maxTokens,
      // @ts-expect-error Ark's switch for thinking, not in OpenAI's types.
      thinking: { type: 'disabled' },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } },
            { type: 'text', text: prompt },
          ],
        },
      ],
    });
    return response.choices[0]?.message?.content?.trim() ?? '';
  }

  /** The model's answer to a question about the screenshot. */
  async ask(shot: Shot, question: string): Promise<string> {
    return this.complete(shot, `这是 Mac 版微信的截图。${question}\n只回答问题本身，不要解释。`, 600);
  }

  /**
   * Where something is in the screenshot, in points, or undefined when the
   * model does not see it.
   */
  async locate(shot: Shot, what: string): Promise<{ x: number; y: number } | undefined> {
    const px = { width: Math.round(shot.width * shot.scale), height: Math.round(shot.height * shot.scale) };
    const text = await this.complete(shot,
      `这是 Mac 版微信的截图，尺寸 ${px.width}x${px.height} 像素，左上角是原点。` +
      `请找出：${what}。只输出一行 JSON：{"found": true, "x": 像素x, "y": 像素y}（给出它的中心点），找不到就输出 {"found": false}。`);
    const match = text.match(/\{[^}]*\}/);
    if (!match) return undefined;
    try {
      const json = JSON.parse(match[0]);
      if (!json.found || typeof json.x !== 'number' || typeof json.y !== 'number') return undefined;
      return { x: json.x / shot.scale, y: json.y / shot.scale };
    } catch {
      return undefined;
    }
  }
}
