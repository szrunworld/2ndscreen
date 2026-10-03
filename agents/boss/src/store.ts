// What the assistant has handled, kept across restarts so it does not
// open or draft a conversation twice, and the BOSS直聘 process it launched,
// so it knows which one is its own.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

interface Saved {
  handled: string[];
  /** The BOSS直聘 process this assistant launched, if it is still about. */
  bossPid?: number;
}

export class Store {
  private data: Saved;

  constructor(readonly path: string, readonly limit = 2000) {
    try {
      const raw = JSON.parse(readFileSync(path, 'utf8'));
      this.data = { handled: Array.isArray(raw.handled) ? raw.handled : [], bossPid: raw.bossPid };
    } catch {
      this.data = { handled: [] };
    }
  }

  has(key: string): boolean {
    return this.data.handled.includes(key);
  }

  add(key: string): void {
    if (this.has(key)) return;
    // Keep the newest; old rows have long left the list.
    this.data.handled = [...this.data.handled, key].slice(-this.limit);
    this.save();
  }

  get bossPid(): number | undefined {
    return this.data.bossPid;
  }

  set bossPid(pid: number | undefined) {
    this.data.bossPid = pid;
    this.save();
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    // Write then rename, so a crash never leaves half a file.
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.data, null, 1), { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}
