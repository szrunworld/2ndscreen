// BOSS直聘 on a 2ndscreen agent screen, driven through the 2ndscreen
// command. Everything goes through accessibility and background events, so
// the user's pointer and frontmost app are left alone. BOSS直聘 ignores
// clicks at a point in the background, so clicks name elements.

import { execFile } from 'node:child_process';
import { chat, type Chat } from './chat.ts';
import { conversations, type Conversation, type Element, type Frame } from './parse.ts';

export class BossError extends Error {}

interface State {
  elements: Element[];
  windowFrame: Frame;
}

export class Boss {
  constructor(
    readonly screen: string,
    readonly pid: number,
    readonly windowId?: number,
    readonly cli = process.env.SECONDSCREEN_CLI || '2ndscreen',
  ) {}

  private run(words: string[]): Promise<Record<string, any>> {
    const target = ['--screen', this.screen, '--pid', String(this.pid)];
    if (this.windowId !== undefined) target.push('--window-id', String(this.windowId));
    return new Promise((resolve, reject) => {
      execFile(this.cli, [...words, ...target], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
        let output: Record<string, any>;
        try {
          output = JSON.parse(stdout);
        } catch {
          reject(new BossError((stderr || stdout || String(error)).trim()));
          return;
        }
        if (output.ok === false) reject(new BossError(output.error ?? `2ndscreen ${words[0]} failed`));
        else resolve(output);
      });
    });
  }

  async state(): Promise<State> {
    const state = await this.run(['state']);
    return { elements: state.elements, windowFrame: state.windowFrame };
  }

  async conversations(): Promise<Conversation[]> {
    const { elements, windowFrame } = await this.state();
    return conversations(elements, windowFrame);
  }

  /** Open a conversation from the list. The candidate sees it as read. */
  async open(conversation: Conversation): Promise<Chat> {
    await this.run(['click', '--index', String(conversation.index)]);
    for (let attempt = 0; attempt < 10; attempt++) {
      await sleep(500);
      const { elements, windowFrame } = await this.state();
      const open = chat(elements, windowFrame);
      if (open && open.candidate.name === conversation.name) return open;
    }
    throw new BossError(`${conversation.name}'s conversation did not open`);
  }

  async chat(): Promise<Chat | undefined> {
    const { elements, windowFrame } = await this.state();
    return chat(elements, windowFrame);
  }

  /** Put `text` in the message box, replacing what is there. Nothing is sent. */
  async draft(text: string): Promise<void> {
    const open = await this.chat();
    if (!open?.input) throw new BossError('no conversation is open');
    const result = await this.run(['type', '--index', String(open.input.index), '--value', text, '--replace']);
    if (result.effect !== 'confirmed') throw new BossError('the draft did not land in the message box');
  }

  /**
   * Click Send, then check the draft now shows as the recruiter's message.
   * Only call this for a draft a person has approved.
   */
  async send(expected: string): Promise<void> {
    const open = await this.chat();
    if (!open?.send) throw new BossError('no Send button');
    if ((open.input?.value ?? '').trim() !== expected.trim()) {
      throw new BossError('the message box no longer holds the approved draft; not sending');
    }
    await this.run(['click', '--index', String(open.send.index)]);
    for (let attempt = 0; attempt < 10; attempt++) {
      await sleep(500);
      const after = await this.chat();
      const mine = after?.messages.filter((m) => m.from === 'me').map((m) => m.text) ?? [];
      if (mine.some((m) => m.includes(expected.trim().slice(0, 12)))) return;
    }
    throw new BossError('sent, but the message did not show in the conversation; check BOSS直聘');
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
