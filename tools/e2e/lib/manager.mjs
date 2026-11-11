// モード(adban / baseline)ごとに 1 つのブラウザを持ち、落ちたら起動し直す。
import { Browser, launchWithExtension } from './browser.mjs';

export const EXT_METHODS = [
  { browser: 'chrome', method: 'pipe' }, // CDP の Extensions.loadUnpacked(Chrome 137 以降のブランド版でも使える)
  { browser: 'chrome', method: 'flag' }, // --load-extension(ブランド版では無効)
  { browser: 'edge', method: 'flag' },   // Edge で --load-extension
  { browser: 'edge', method: 'pipe' },
];

export class Manager {
  constructor({ mode, extSrc, headless = true, log = () => {} }) {
    this.mode = mode;
    this.extSrc = extSrc;
    this.headless = headless;
    this.log = log;
    this.browser = null;
    this.starting = null;
    this.methods = EXT_METHODS;
    this.launchCount = 0;
    this.info = null;
  }

  /** 生きているブラウザを返す。死んでいれば起動し直す(同時に呼ばれても 1 回だけ) */
  async get() {
    if (this.browser && this.browser.alive) return this.browser;
    if (!this.starting) {
      this.starting = (async () => {
        if (this.browser) { try { await this.browser.close(); } catch { /* 無視 */ } this.browser = null; }
        this.launchCount++;
        if (this.mode === 'adban') {
          const { browser } = await launchWithExtension({ extSrc: this.extSrc, headless: this.headless, methods: this.methods, log: this.log });
          this.browser = browser;
          const [br, method] = browser.methodName.split(':');
          this.methods = [{ browser: br, method }]; // 次回からは動いた方法だけを使う
          this.info = { method: browser.methodName, version: browser.version, ext: browser.extInfo };
        } else {
          // baseline は adban で使うのと同じブラウザ種別で、拡張機能なし
          const br = this.baselineBrowser || 'chrome';
          const b = new Browser({ browser: br, extDir: null, method: 'pipe', headless: this.headless });
          await b.launch();
          this.browser = b;
          this.info = { method: br + ':no-extension', version: b.version };
        }
        this.log(`[${this.mode}] ブラウザ起動 (${this.info.method}, ${this.info.version}) #${this.launchCount}`);
        return this.browser;
      })().finally(() => { this.starting = null; });
    }
    return this.starting;
  }

  async close() {
    if (this.starting) { try { await this.starting; } catch { /* 無視 */ } }
    if (this.browser) { try { await this.browser.close(); } catch { /* 無視 */ } }
    this.browser = null;
  }
}
