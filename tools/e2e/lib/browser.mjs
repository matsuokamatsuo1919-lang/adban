// Chrome / Edge を CDP パイプ(--remote-debugging-pipe)で操作する最小ライブラリ。
// 依存なし。Node 24 の child_process と fs だけで動く。
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function withTimeout(promise, ms, label = 'timeout') {
  let t;
  const timer = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(label)), ms); });
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}

export const BROWSERS = {
  chrome: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  edge: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
};

// 拡張機能本体を一時ディレクトリへコピーする(tools / node_modules / .git / _metadata は除く)
export function copyExtension(srcDir, destDir) {
  const skip = new Set(['tools', 'node_modules', '.git', '_metadata']);
  fs.cpSync(srcDir, destDir, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(srcDir, src);
      if (!rel) return true;
      return !skip.has(rel.split(path.sep)[0]);
    },
  });
}

export function rmDirSafe(dir) {
  for (let i = 0; i < 5; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return; } catch { /* ロック待ち */ }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
}

export class Browser {
  /**
   * @param {object} o
   * @param {'chrome'|'edge'} o.browser
   * @param {string|null} o.extDir 読み込む拡張機能(コピー済み)。null なら拡張機能なし
   * @param {'pipe'|'flag'} o.method 拡張機能の読み込み方法
   * @param {boolean} o.headless
   */
  constructor(o) {
    this.o = o;
    this.child = null;
    this.alive = false;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = [];
    this.buf = '';
    this.userDataDir = null;
    this.extId = null;
    this.extInfo = null;
    this.userAgent = null;
  }

  async launch() {
    const o = this.o;
    this.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adban-e2e-profile-'));
    const args = [
      `--user-data-dir=${this.userDataDir}`,
      '--remote-debugging-pipe',
      '--no-first-run', '--no-default-browser-check',
      '--disable-search-engine-choice-screen',
      '--autoplay-policy=no-user-gesture-required',
      '--mute-audio',
      '--window-size=1366,900',
      '--disable-popup-blocking',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--lang=ja-JP',
      '--accept-lang=ja-JP,ja,en-US,en',
    ];
    if (o.headless) args.push('--headless=new');
    else args.push('--window-position=-2400,0');
    if (o.extDir) {
      if (o.method === 'pipe') {
        args.push('--enable-unsafe-extension-debugging');
      } else {
        args.push('--disable-features=DisableLoadExtensionCommandLineSwitch', `--load-extension=${o.extDir}`);
      }
    }
    args.push('about:blank');
    const exe = BROWSERS[o.browser];
    this.child = spawn(exe, args, {
      stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.alive = true;
    this.child.on('exit', () => { this._onDead(); });
    this.child.on('error', () => { this._onDead(); });
    const w = this.child.stdio[3];
    const r = this.child.stdio[4];
    w.on('error', () => {});
    r.on('error', () => {});
    r.on('data', (d) => this._onData(d));
    r.on('close', () => this._onDead());

    const v = await withTimeout(this.send('Browser.getVersion'), 30000, 'ブラウザの起動がタイムアウトしました');
    this.version = v.product;
    this.userAgent = v.userAgent.replace(/HeadlessChrome/g, 'Chrome');

    if (o.extDir && o.method === 'pipe') {
      const res = await this.send('Extensions.loadUnpacked', { path: o.extDir });
      this.extId = res.id;
    }
    if (o.extDir) await this._waitExtensionReady();
  }

  _onDead() {
    if (!this.alive) return;
    this.alive = false;
    for (const [, p] of this.pending) p.rej(new Error('ブラウザが終了しました'));
    this.pending.clear();
  }

  _onData(d) {
    this.buf += d.toString('utf8');
    let i;
    while ((i = this.buf.indexOf('\0')) >= 0) {
      const raw = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!raw) continue;
      let msg;
      try { msg = JSON.parse(raw); } catch { continue; }
      if (msg.id != null) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.error) p.rej(new Error(`${p.method}: ${msg.error.message}`));
          else p.res(msg.result || {});
        }
      } else if (msg.method) {
        for (const l of this.listeners.slice()) {
          if ((l.sessionId === undefined || l.sessionId === (msg.sessionId || null)) &&
              (l.method === null || l.method === msg.method)) {
            try { l.fn(msg.params || {}, msg.sessionId || null, msg.method); } catch { /* 無視 */ }
          }
        }
      }
    }
  }

  send(method, params = {}, sessionId = undefined) {
    if (!this.alive) return Promise.reject(new Error('ブラウザが終了しています'));
    const id = this.nextId++;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej, method });
      try { this.child.stdio[3].write(JSON.stringify(msg) + '\0'); } catch (e) { this.pending.delete(id); rej(e); }
    });
  }

  /** sessionId: undefined=全セッション, null=ブラウザ直下, 文字列=そのセッション */
  on(sessionId, method, fn) {
    const l = { sessionId, method, fn };
    this.listeners.push(l);
    return () => { this.listeners = this.listeners.filter((x) => x !== l); };
  }

  async _waitExtensionReady() {
    const t0 = Date.now();
    // 1) 拡張機能の service worker ターゲットを探す
    let sessionId = null;
    const checked = new Set();
    while (Date.now() - t0 < 30000 && !sessionId) {
      const { targetInfos } = await this.send('Target.getTargets');
      for (const t of targetInfos) {
        if (t.type !== 'service_worker' || !t.url.startsWith('chrome-extension://')) continue;
        if (this.extId ? !t.url.startsWith(`chrome-extension://${this.extId}/`) : checked.has(t.targetId)) continue;
        checked.add(t.targetId);
        // 内蔵のコンポーネント拡張機能の service worker も混ざるので、名前で ADBAN を見分ける
        const a = await this.send('Target.attachToTarget', { targetId: t.targetId, flatten: true }).catch(() => null);
        if (!a) continue;
        let name = null;
        try {
          const r = await this.send('Runtime.evaluate', { expression: 'chrome.runtime.getManifest().name', returnByValue: true }, a.sessionId);
          name = r.result?.value;
        } catch { /* 無視 */ }
        if (name === 'ADBAN') { sessionId = a.sessionId; this.extId = t.url.split('/')[2]; break; }
        try { await this.send('Target.detachFromTarget', { sessionId: a.sessionId }); } catch { /* 無視 */ }
      }
      if (!sessionId) await sleep(500);
    }
    if (!sessionId) throw new Error('拡張機能の service worker が見つかりません(読み込みに失敗した可能性)');
    // 2) 登録済みスクリプトの件数が 0 より大きく、2 秒間変わらなくなるまで待つ
    let last = -1; let since = 0; let count = 0;
    while (Date.now() - t0 < 60000) {
      let n = 0;
      try {
        const r = await this.send('Runtime.evaluate', {
          expression: 'chrome.scripting.getRegisteredContentScripts().then(r => r.length)',
          awaitPromise: true, returnByValue: true,
        }, sessionId);
        n = r.result?.value ?? 0;
      } catch { n = 0; }
      if (n > 0 && n === last) {
        if (Date.now() - since >= 2000) { count = n; break; }
      } else {
        last = n; since = Date.now();
      }
      await sleep(400);
    }
    let rulesets = [];
    let version = null;
    try {
      const r = await this.send('Runtime.evaluate', {
        expression: '(async()=>({rs: await chrome.declarativeNetRequest.getEnabledRulesets(), v: chrome.runtime.getManifest().version}))()',
        awaitPromise: true, returnByValue: true,
      }, sessionId);
      rulesets = r.result?.value?.rs || [];
      version = r.result?.value?.v || null;
    } catch { /* 無視 */ }
    this.extInfo = {
      id: this.extId, registeredScripts: count, stable: count > 0,
      enabledRulesets: rulesets, version,
      readyMs: Date.now() - t0,
    };
    try { await this.send('Target.detachFromTarget', { sessionId }); } catch { /* 無視 */ }
  }

  async close() {
    const child = this.child;
    if (child && this.alive) {
      try { await withTimeout(this.send('Browser.close'), 3000); } catch { /* 無視 */ }
      for (let i = 0; i < 20 && this.alive; i++) await sleep(250);
    }
    if (child && child.exitCode === null && child.pid) {
      // 自分で起動したプロセスだけを終了する
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    }
    this.alive = false;
    await sleep(300);
    if (this.userDataDir) rmDirSafe(this.userDataDir);
    if (this.extCopy) rmDirSafe(this.extCopy);
  }
}

/** 拡張機能の読み込み方法を順に試し、動いた Browser を返す */
export async function launchWithExtension({ extSrc, headless = true, methods, log = () => {} }) {
  const tried = [];
  for (const m of methods) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adban-e2e-ext-'));
    copyExtension(extSrc, tmp);
    const b = new Browser({ browser: m.browser, extDir: tmp, method: m.method, headless });
    b.extCopy = tmp;
    try {
      await b.launch();
      b.methodName = `${m.browser}:${m.method}`;
      return { browser: b, tried };
    } catch (e) {
      tried.push(`${m.browser}:${m.method} => ${e.message}`);
      log(`読み込み方法 ${m.browser}:${m.method} は失敗: ${e.message}`);
      try { await b.close(); } catch { /* 無視 */ }
    }
  }
  throw new Error('拡張機能をどの方法でも読み込めませんでした: ' + tried.join(' / '));
}
