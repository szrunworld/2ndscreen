// Runs the 2ndscreen command, which prints one JSON object per call.

import { execFile } from 'node:child_process';
import type { Frame } from './plan.ts';

export class ScreenError extends Error {}

export class SecondScreen {
  constructor(readonly executable = process.env.SECONDSCREEN_CLI || '2ndscreen') {}

  run(words: string[]): Promise<Record<string, any>> {
    return new Promise((resolve, reject) => {
      execFile(this.executable, words, { maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
        let output: Record<string, any>;
        try {
          output = JSON.parse(stdout);
        } catch {
          reject(new ScreenError((stderr || stdout || String(error)).trim()));
          return;
        }
        if (output.ok === false) reject(new ScreenError(output.error ?? `2ndscreen ${words[0]} failed`));
        else resolve(output);
      });
    });
  }

  /** The screen's current frame. Frames move when screens come and go. */
  async frame(screen: string): Promise<Frame> {
    const list = await this.run(['screen', 'list']);
    const found = (list.screens ?? []).find((s: any) => s.name === screen);
    if (!found) throw new ScreenError(`no screen named "${screen}"`);
    return found.frame;
  }
}
