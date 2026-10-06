// Friend requests: reading 新的朋友, accepting a request a person approved,
// and sending one by WeChat ID or phone number.

import { withWeChatInFront } from './front.ts';
import { chats, detail, layout, norm, requests, sameName, type ChatRow, type Detail, type Request } from './parse.ts';
import { sleep, WeChatError, type Shot, type WeChat, type Word } from './screen.ts';
import type { Vision } from './see.ts';

const ACCEPT = ['接受', '通过验证', '添加到通讯录', '前往验证'];
const FINISH = ['完成', '确定'];

export interface FriendsOptions {
  vision?: Vision;
  /** Bring WeChat to the front for the steps that need it (its popups). */
  foreground?: boolean;
  log?: (line: string) => void;
}

export class Friends {
  constructor(readonly wx: WeChat, readonly options: FriendsOptions = {}) {}

  private log(line: string): void {
    this.options.log?.(line);
  }

  private async sidebar(name: string): Promise<{ shot: Shot; words: Word[] }> {
    const shot = await this.wx.shot(name);
    return { shot, words: await this.wx.ocr(shot, layout.sidebar) };
  }

  /** The chat list, as the chats tab shows it. */
  async chatList(): Promise<ChatRow[]> {
    let { shot, words } = await this.sidebar('chats');
    if (words.some((w) => norm(w.text).includes('通讯录管理'))) {
      await this.wx.click(shot, layout.rail.chats.x, layout.rail.chats.y);
      await sleep(800);
      ({ shot, words } = await this.sidebar('chats'));
    }
    return chats(words);
  }

  /** The 新的朋友 rows, with the contacts tab open and the section expanded. */
  async newFriends(): Promise<{ shot: Shot; rows: Request[] }> {
    let { shot, words } = await this.sidebar('sidebar');
    const find = () => words.find((w) => norm(w.text).includes('新的朋友'));
    if (!find()) {
      await this.wx.click(shot, layout.rail.contacts.x, layout.rail.contacts.y);
      await sleep(800);
      ({ shot, words } = await this.sidebar('sidebar'));
    }
    const header = find();
    if (!header) throw new WeChatError('the contacts tab does not show 新的朋友');
    let rows = requests(words);
    if (rows.length === 0) {
      // Collapsed: the header opens it.
      await this.wx.click(shot, header.x + header.w / 2, header.y + header.h / 2);
      await sleep(800);
      ({ shot, words } = await this.sidebar('sidebar'));
      rows = requests(words);
    }
    // A request waiting for an answer shows a green 接受 button where the
    // others show their status in grey.
    for (const row of rows) {
      if (!row.pending) continue;
      const colour = await this.wx.color(shot, { x: layout.request.statusX, y: row.y - 12, w: 48, h: 24 });
      row.pending = row.status === '接受' || colour.green > 0.15;
    }
    return { shot, rows };
  }

  /** Open a request from the list and read the pane. */
  async open(row: Request, shot: Shot): Promise<{ shot: Shot; detail: Detail }> {
    await this.wx.click(shot, layout.request.nameX + 20, row.y);
    for (let attempt = 0; attempt < 8; attempt++) {
      await sleep(500);
      const next = await this.wx.shot('detail');
      const seen = detail(await this.wx.ocr(next, layout.pane));
      if (seen && sameName(row.name, seen.name)) return { shot: next, detail: seen };
    }
    throw new WeChatError(`${row.name}'s request did not open`);
  }

  /** Words on the whole screen to the right of the sidebar: dialogs are windows of their own. */
  private async paneOnScreen(name: string): Promise<{ shot: Shot; words: Word[]; seen?: Detail }> {
    const shot = await this.wx.screenShot(name);
    const words = (await this.wx.ocr(shot)).filter((w) => w.x > layout.pane.x);
    return { shot, words, seen: detail(words) };
  }

  /**
   * Accept the open request. Only call this for a request a person approved.
   * Returns what the list says afterwards.
   */
  async accept(row: Request, shot: Shot, seen: Detail): Promise<string> {
    const act = async () => {
      let button = seen.buttons.find((b) => ACCEPT.includes(b.text));
      let where: { shot: Shot; x: number; y: number } | undefined = button ? { shot, ...button } : undefined;
      if (!where && row.status === '接受') {
        where = { shot, x: layout.request.statusX + 20, y: row.y };
      }
      if (!where && this.options.vision) {
        const found = await this.options.vision.locate(shot, '接受这条好友申请的绿色按钮（文字可能是"接受"或"通过验证"）');
        if (found) where = { shot, ...found };
      }
      if (!where) throw new WeChatError('no accept button is visible for this request');
      this.log(`clicking accept for ${row.name}`);
      await this.wx.click(where.shot, where.x, where.y);
      // WeChat may ask for a remark and tags first; 完成 keeps its suggestions.
      for (let round = 0; round < 4; round++) {
        await sleep(900);
        const { shot: next, words, seen: after } = await this.paneOnScreen('after-accept');
        const finish = after?.buttons.find((b) => FINISH.includes(b.text));
        if (finish) {
          this.log(`clicking ${finish.text}`);
          await this.wx.click(next, finish.x, finish.y);
          continue;
        }
        if (after?.buttons.some((b) => b.text === '发消息')) break;
        if (words.some((w) => /已过期|已被拒绝|操作失败|频繁/.test(norm(w.text)))) {
          throw new WeChatError(`WeChat says: ${words.map((w) => w.text).join(' ')}`);
        }
      }
    };
    if (this.options.foreground) await withWeChatInFront(act, { log: this.log.bind(this) });
    else await act();
    const { rows } = await this.newFriends();
    return rows.find((r) => sameName(r.name, row.name))?.status ?? 'unknown';
  }

  /**
   * Send a friend request to a WeChat ID or phone number. WeChat shows its
   * search results and the add-friend card only while it is in front, so
   * this brings it forward for a few seconds. `approve` sees what the
   * request dialog says and decides whether to send.
   */
  async add(id: string, note: string | undefined, approve: (lines: string[]) => Promise<boolean>): Promise<'sent' | 'cancelled'> {
    return withWeChatInFront(async () => {
      const shot = await this.wx.shot('search');
      await this.wx.click(shot, layout.search.x, layout.search.y);
      await sleep(300);
      await this.wx.type(id);
      await sleep(1500);
      let screen = await this.wx.screenShot('results');
      let words = await this.wx.ocr(screen);
      const box = words.find((w) => w.y < 60 && norm(w.text).includes(norm(id).slice(0, 6)));
      try {
        if (!box) throw new WeChatError('the search box did not take the ID; nothing typed elsewhere?');
        const lookup = (ws: Word[]) => ws.find((w) => w.y > 60 && w.x < 320 && /网络查找|查找手机|查找微信号/.test(norm(w.text)));
        let hit = lookup(words);
        if (!hit) {
          // The results popup does not always open on the first keystrokes; a further one usually brings it.
          await this.wx.type(' ');
          await this.wx.key('delete');
          await sleep(1500);
          screen = await this.wx.screenShot('results');
          words = await this.wx.ocr(screen);
          hit = lookup(words);
        }
        let target = hit ? { x: hit.x + hit.w / 2, y: hit.y + hit.h / 2 } : await this.options.vision?.locate(screen, `搜索框下方弹出的结果里"网络查找微信号：${id}"那一项`);
        if (!target) throw new WeChatError(`no search result offers to look ${id} up; the ID may be wrong, or WeChat showed no results`);
        // Posted clicks fall through the popup; only a real one lands on it.
        await this.wx.realClick(screen, target.x, target.y);
        await sleep(1800);
        screen = await this.wx.screenShot('profile');
        words = await this.wx.ocr(screen);
        if (words.some((w) => /该用户不存在|用户不存在|被搜索的账号状态异常|无法找到|找不到相关账号/.test(norm(w.text)))) {
          throw new WeChatError(`WeChat says: ${words.filter((w) => w.x > layout.pane.x).map((w) => w.text).join(' ')}`);
        }
        const addWord = words.find((w) => norm(w.text) === '添加到通讯录');
        target = addWord ? { x: addWord.x + addWord.w / 2, y: addWord.y + addWord.h / 2 } : await this.options.vision?.locate(screen, '"添加到通讯录"按钮');
        if (!target) {
          if (words.some((w) => norm(w.text) === '发消息')) throw new WeChatError(`${id} is already a friend`);
          throw new WeChatError('no 添加到通讯录 button is visible');
        }
        await this.wx.realClick(screen, target.x, target.y);
        await sleep(1500);
        screen = await this.wx.screenShot('verify');
        words = await this.wx.ocr(screen);
        const send = words.find((w) => norm(w.text) === '发送');
        if (!send) throw new WeChatError('the verification dialog did not appear');
        if (note) {
          // The verification message field holds WeChat's "我是 …" text; replace it.
          const field = words.find((w) => /^我是/.test(norm(w.text)) && w.y < send.y);
          if (field) {
            await this.wx.realClick(screen, field.x + field.w / 2, field.y + field.h / 2);
            await sleep(200);
            await this.wx.key('a', 'cmd');
            await this.wx.type(note);
            await sleep(500);
            screen = await this.wx.screenShot('verify');
            words = await this.wx.ocr(screen);
          } else {
            this.log('could not find the verification message field; keeping WeChat\'s default text');
          }
        }
        const dialog = words.filter((w) => w.x > layout.pane.x && w.y < (words.find((v) => norm(v.text) === '发送')?.y ?? 9999) + 20).map((w) => w.text);
        if (!(await approve(dialog))) {
          const cancel = words.find((w) => norm(w.text) === '取消');
          if (cancel) await this.wx.realClick(screen, cancel.x + cancel.w / 2, cancel.y + cancel.h / 2);
          else await this.wx.key('escape');
          return 'cancelled';
        }
        const sendNow = words.find((w) => norm(w.text) === '发送')!;
        await this.wx.realClick(screen, sendNow.x + sendNow.w / 2, sendNow.y + sendNow.h / 2);
        await sleep(1200);
        const after = await this.wx.ocr(await this.wx.screenShot('sent'));
        this.log(after.filter((w) => w.x > layout.pane.x).map((w) => w.text).join(' '));
        return 'sent';
      } finally {
        // Leave the 添加朋友 window closed and the search box empty.
        await this.wx.key('escape');
        await sleep(200);
        await this.wx.closeWindow('添加朋友');
        const clean = await this.wx.shot('clear');
        await this.wx.click(clean, layout.searchClear.x, layout.searchClear.y);
      }
    }, { log: this.log.bind(this) });
  }
}
