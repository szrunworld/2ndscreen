// What the assistant has handled, kept across restarts so it does not act
// on a friend request twice, and the WeChat process it launched, so it
// knows which one is its own.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

interface Saved {
  handled: string[];
  /** The WeChat process this assistant launched, if it is still about. */
  wechatPid?: number;
}

export class Store {
  private data: Saved;

  constructor(readonly path: string, readonly limit = 2000) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      this.data = { handled: Array.isArray(raw.handled) ? raw.handled : [], wechatPid: raw.wechatPid };
    } catch {
      this.data = { handled: [] };
    }
  }

  has(key: string): boolean {
    return this.data.handled.includes(key);
  }

  add(key: string): void {
    if (this.has(key)) return;
    this.data.handled = [...this.data.handled, key].slice(-this.limit);
    this.save();
  }

  get wechatPid(): number | undefined {
    return this.data.wechatPid;
  }

  set wechatPid(pid: number | undefined) {
    this.data.wechatPid = pid;
    this.save();
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.data, null, 1), { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}
