// 1 ページを開いて、通信・画面上の広告らしさ・壊れ具合・検出メッセージを測る。
import fs from 'node:fs';
import path from 'node:path';
import { sleep, withTimeout } from './browser.mjs';

const TWO_PART_SLD = new Set(['co', 'com', 'ne', 'or', 'go', 'ac', 'ad', 'ed', 'gr', 'lg', 'org', 'net', 'gov', 'edu']);

/** 簡易的な登録ドメイン(eTLD+1)。厳密ではないが第三者判定の目安には十分 */
export function registrable(host) {
  if (!host) return '';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) return host;
  const p = host.split('.');
  if (p.length <= 2) return host;
  const tld = p[p.length - 1];
  const sld = p[p.length - 2];
  if (tld.length === 2 && TWO_PART_SLD.has(sld)) return p.slice(-3).join('.');
  return p.slice(-2).join('.');
}

export function stripQuery(u) {
  try { const x = new URL(u); return x.protocol + '//' + x.host + x.pathname; } catch { return String(u).split(/[?#]/)[0]; }
}

export function slugify(url) {
  const u = new URL(url);
  const s = (u.hostname + u.pathname + u.search).replace(/^www\./, '').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return s.slice(0, 80) || 'page';
}

// ページ内で評価する計測コード(文字列。1 つの式として評価される)
export const PAGE_PROBE = `(() => {
  const AD_FRAME = /(^|[^a-z])(ads?|advert\\w*|adserver|adslot|adunit|adbanner)([^a-z]|$)|doubleclick|googlesyndication|adservice|taboola|outbrain|criteo|pubmatic|amazon-adsystem|sponsor|promo/i;
  const AD_ELEM = /(^|[^a-z])(ads?|advert\\w*|adsbygoogle|adslot|adunit|adbanner|adcontainer|adwrapper|banner-?ad|sponsor\\w*|dfp|taboola|outbrain|googlead\\w*|google_ads\\w*|promo)([^a-z]|$)/i;
  // 'pr' は Tailwind の余白指定(pr-4, pr-0, md:pr-2)や短縮 class(_pr)と紛らわしいので、class / id の語としては見ない。
  // 広告とみなすのは、(a) pr-banner / pr_area のように pr の後に英字の名前が続く語、(b) 語が pr そのもので、要素のテキストが「PR」のとき。
  const isPrAd = (el) => {
    const names = (el.id || '') + ' ' + String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : (el.className || ''));
    for (const t of names.toLowerCase().split(/\\s+/)) {
      if (/^pr[-_][a-z]{2,}/.test(t) && !/^pr-(px|auto)$/.test(t)) return true;
      if (t === 'pr' && /^pr$/i.test((el.textContent || '').trim())) return true;
    }
    return false;
  };
  const DETECT = /広告ブロッカー?[をの]?(無効|オフ|解除|停止)|広告ブロック|ホワイトリスト|ad ?-?block|ad ?blocker|ブロッカー/i;
  const vis = (el, minW, minH) => {
    const r = el.getBoundingClientRect();
    if (r.width * r.height <= 0 || r.width < minW || r.height < minH) return null;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse' || parseFloat(cs.opacity) === 0) return null;
    }
    return r;
  };
  const desc = (el, r) => ({
    tag: el.tagName.toLowerCase(), id: el.id || '', class: String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : (el.className || '')).slice(0, 120),
    src: (el.src || el.getAttribute('data-src') || '').slice(0, 160),
    w: Math.round(r.width), h: Math.round(r.height),
  });
  const frames = [];
  for (const f of document.querySelectorAll('iframe')) {
    const r = vis(f, 1, 1);
    if (!r) continue;
    let host = '';
    try { host = new URL(f.src, location.href).hostname; } catch (e) {}
    const hay = [host + (f.src ? new URL(f.src, location.href).pathname : ''), f.id, f.name, f.className].join(' ');
    if (AD_FRAME.test(hay) || isPrAd(f)) frames.push(desc(f, r));
  }
  const matched = new Set();
  const all = document.body ? document.body.querySelectorAll('[id],[class]') : [];
  for (const el of all) {
    if (el.tagName === 'IFRAME' || el.tagName === 'SCRIPT' || el.tagName === 'STYLE' || el.tagName === 'HTML' || el.tagName === 'BODY') continue;
    const hay = (el.id || '') + ' ' + String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : (el.className || ''));
    if (AD_ELEM.test(hay) || isPrAd(el)) matched.add(el);
  }
  const elems = [];
  for (const el of matched) {
    let p = el.parentElement, nested = false;
    while (p) { if (matched.has(p)) { nested = true; break; } p = p.parentElement; }
    if (nested) continue;
    const r = vis(el, 30, 30);
    if (r) elems.push(desc(el, r));
  }
  const msgs = [];
  if (document.body) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let n;
    while ((n = walker.nextNode()) && msgs.length < 3) {
      const t = n.tagName;
      if (t === 'SCRIPT' || t === 'STYLE' || t === 'NOSCRIPT' || t === 'TEMPLATE') continue;
      let own = '';
      for (const c of n.childNodes) if (c.nodeType === 3) own += c.nodeValue;
      own = own.trim();
      if (own.length < 4 || own.length > 400 || !DETECT.test(own)) continue;
      if (n.closest('a, h1, h2, h3, h4, title, button, summary')) continue; // 記事リンクや見出しは誤検出になりやすい
      if (vis(n, 1, 1)) msgs.push(own.replace(/\\s+/g, ' ').slice(0, 160));
    }
  }
  // 中身のない広告枠: 「広告」「PR」などのラベルだけが見えていて、枠の中に見える画像・iframe・動画・canvas・svg が無い
  const EMPTY_LBL = /^(advertisement|ad|ads|sponsored|広告|pr|スポンサー(ド)?(リンク)?|スポンサー)$/i;
  const emptySlots = [];
  let emptyCount = 0;
  if (document.body) {
    const w2 = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let n2;
    while ((n2 = w2.nextNode())) {
      const t2 = n2.tagName;
      if (t2 === 'SCRIPT' || t2 === 'STYLE' || t2 === 'NOSCRIPT' || t2 === 'TEMPLATE' || t2 === 'SVG') continue;
      let own2 = '';
      for (const c of n2.childNodes) if (c.nodeType === 3) own2 += c.nodeValue;
      own2 = own2.trim();
      if (!own2 || own2.length > 20 || !EMPTY_LBL.test(own2)) continue;
      if (!vis(n2, 1, 1)) continue;
      let frame = n2.parentElement;
      for (let k = 0; k < 2 && frame && frame.children.length === 1 && frame.parentElement && frame.parentElement !== document.body; k++) frame = frame.parentElement;
      if (!frame) continue;
      let has = false;
      for (const m of frame.querySelectorAll('img,iframe,video,canvas,svg')) {
        if (n2.contains(m)) continue;
        const mr = vis(m, 5, 5);
        if (mr && mr.width * mr.height >= 400) { has = true; break; }
      }
      if (has) continue;
      emptyCount++;
      if (emptySlots.length < 5) {
        const fr = frame.getBoundingClientRect();
        emptySlots.push({ tag: frame.tagName.toLowerCase(), class: String(frame.className && frame.className.baseVal !== undefined ? frame.className.baseVal : (frame.className || '')).slice(0, 120), label: own2, w: Math.round(fr.width), h: Math.round(fr.height) });
      }
    }
  }
  // Cookie・同意のダイアログ(画面の 8% 以上を占めるもの)
  const CONSENT_TXT = /cookie|consent|同意|プライバシー|個人情報/i;
  const CONSENT_FRAME = /consent|cookie|sp_message|onetrust|privacy|cmp|didomi|quantcast|trustarc/i;
  let consent = null;
  const vw = innerWidth, vh = innerHeight;
  const cands = document.querySelectorAll('[role=dialog],[role=alertdialog],[aria-modal=true],dialog,[id*=cookie i],[id*=consent i],[class*=cookie i],[class*=consent i],[id*=onetrust i],[id^=sp_message],[class*=privacy i],[id*=privacy i],[id*=cmp i],[class*=didomi i],[id*=didomi i]');
  for (const el of cands) {
    const r = vis(el, 1, 1);
    if (!r) continue;
    if (el.tagName === 'HTML' || el.tagName === 'BODY' || r.height > vh * 1.05) continue; // ページ全体を覆うだけの要素は除く
    const area = Math.min(r.width, vw) * Math.min(r.height, vh);
    if (area < vw * vh * 0.08) continue;
    const isFrame = el.tagName === 'IFRAME';
    const txt = (el.innerText || '').replace(/\s+/g, ' ');
    if (!(isFrame || CONSENT_TXT.test(txt))) continue;
    consent = { tag: el.tagName.toLowerCase(), id: el.id || '', class: String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : (el.className || '')).slice(0, 80), w: Math.round(r.width), h: Math.round(r.height), text: txt.slice(0, 100) };
    break;
  }
  if (!consent) {
    for (const f of document.querySelectorAll('iframe')) {
      const r = vis(f, 1, 1);
      if (!r || r.width * r.height < vw * vh * 0.08) continue;
      if (CONSENT_FRAME.test([f.id, f.name, f.className, f.src].join(' '))) {
        consent = { tag: 'iframe', id: f.id || '', class: String(f.className || '').slice(0, 80), w: Math.round(r.width), h: Math.round(r.height), text: '(iframe) ' + (f.src || '').slice(0, 80) };
        break;
      }
    }
  }
  const b = document.body, h = document.documentElement;
  const bs = b ? getComputedStyle(b) : null, hs = getComputedStyle(h);
  return {
    adIframes: frames.length, adIframeList: frames.slice(0, 10),
    adElems: elems.length, adElemList: elems.slice(0, 10),
    textLen: b ? b.innerText.length : 0,
    scrollHeight: Math.max(h.scrollHeight, b ? b.scrollHeight : 0),
    detectMessages: msgs,
    emptyAdSlots: emptyCount, emptyAdSlotList: emptySlots,
    consent,
    bodyOverflow: bs ? bs.overflow + '/' + bs.overflowY : '', htmlOverflow: hs.overflow + '/' + hs.overflowY,
    bodyLocked: !!(bs && (bs.overflowY === 'hidden' || (bs.position === 'fixed' && b.scrollHeight > innerHeight * 1.5))) || hs.overflowY === 'hidden' && h.scrollHeight > innerHeight * 1.2,
    title: document.title, finalUrl: location.href,
  };
})()`;

/** 1 つのタブ(ページ)。子ターゲット(OOPIF・ワーカー)の通信も集める */
export class Page {
  constructor(browser) {
    this.b = browser;
    this.requests = new Map(); // key -> {url,type,status,failed,errorText,blocked,fromSession}
    this.consoleErrors = 0;
    this.networkLogErrors = 0;
    this.errorSamples = [];
    this.consoleLog = [];
    this.sessions = new Set();
    this.offs = [];
  }

  async open() {
    const b = this.b;
    const { targetId } = await b.send('Target.createTarget', { url: 'about:blank' });
    this.targetId = targetId;
    const { sessionId } = await b.send('Target.attachToTarget', { targetId, flatten: true });
    this.sid = sessionId;
    this.offs.push(b.on(undefined, null, (p, sid, m) => this._event(p, sid, m)));
    await this._setup(sessionId, true);
    await b.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
  }

  async _setup(sid, isMain) {
    const b = this.b;
    this.sessions.add(sid);
    const calls = [
      b.send('Network.enable', {}, sid),
      b.send('Runtime.enable', {}, sid),
      b.send('Network.setUserAgentOverride', { userAgent: b.userAgent, acceptLanguage: 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7' }, sid),
    ];
    if (isMain) {
      calls.push(
        b.send('Page.enable', {}, sid),
        b.send('Log.enable', {}, sid),
        b.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 800, deviceScaleFactor: 1, mobile: false }, sid),
        b.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sid),
      );
    }
    await Promise.allSettled(calls);
  }

  _event(p, sid, method) {
    if (!this.sessions.has(sid)) return;
    switch (method) {
      case 'Target.attachedToTarget': {
        const child = p.sessionId;
        const type = p.targetInfo?.type;
        (async () => {
          try {
            if (type === 'iframe' || type === 'page' || type === 'worker' || type === 'shared_worker' || type === 'service_worker') {
              await this._setup(child, false);
              if (type === 'iframe') {
                await this.b.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, child);
              }
            }
          } catch { /* 無視 */ }
          try { await this.b.send('Runtime.runIfWaitingForDebugger', {}, child); } catch { /* 無視 */ }
        })();
        break;
      }
      case 'Network.requestWillBeSent': {
        const key = sid + ':' + p.requestId;
        const prev = this.requests.get(key);
        if (prev && p.redirectResponse) {
          prev.status = p.redirectResponse.status;
          // リダイレクト前のリクエストは別エントリとして数える。リダイレクト先が chrome-extension:// なら、
          // 拡張機能(declarativeNetRequest の redirect)による差し替え
          const toExt = /^chrome-extension:/i.test(p.request.url);
          this.requests.set(key + '#' + this.requests.size, { ...prev, redirected: true, replaced: toExt, replacedTo: toExt ? p.request.url : undefined });
        }
        this.requests.set(key, { url: p.request.url, type: p.type, status: null, failed: false, errorText: null, blocked: false });
        break;
      }
      case 'Network.responseReceived': {
        const r = this.requests.get(sid + ':' + p.requestId);
        if (r) r.status = p.response.status;
        break;
      }
      case 'Network.loadingFailed': {
        const r = this.requests.get(sid + ':' + p.requestId);
        if (r) {
          r.failed = true;
          r.errorText = p.errorText;
          r.blocked = p.errorText === 'net::ERR_BLOCKED_BY_CLIENT';
        }
        break;
      }
      case 'Runtime.exceptionThrown':
        this.consoleErrors++;
        if (this.errorSamples.length < 5) this.errorSamples.push((p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || '').slice(0, 160));
        break;
      case 'Runtime.consoleAPICalled':
        if (this.consoleLog.length < 200) this.consoleLog.push({ type: p.type, text: (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300) });
        if (p.type === 'error') {
          this.consoleErrors++;
          if (this.errorSamples.length < 5) this.errorSamples.push((p.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 160));
        }
        break;
      case 'Log.entryAdded':
        if (this.consoleLog.length < 200) this.consoleLog.push({ type: 'log:' + (p.entry?.source || '') + ':' + (p.entry?.level || ''), text: (p.entry?.text || '').slice(0, 300), url: stripQuery(p.entry?.url || '') });
        if (p.entry?.level === 'error') {
          if (p.entry.source === 'network') this.networkLogErrors++;
          else { this.consoleErrors++; if (this.errorSamples.length < 5) this.errorSamples.push((p.entry.text || '').slice(0, 160)); }
        }
        break;
      case 'Page.loadEventFired':
        if (sid === this.sid && this._onLoad) this._onLoad();
        break;
      default:
    }
  }

  send(method, params) { return this.b.send(method, params, this.sid); }

  async eval(expr, { timeout = 10000 } = {}) {
    const r = await withTimeout(this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }), timeout, 'evaluate がタイムアウト');
    if (r.exceptionDetails) throw new Error('evaluate 例外: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result?.value;
  }

  /** ナビゲートして load を待つ。load が来なくても timeout で戻る(loadTimedOut=true) */
  async navigate(url, loadTimeout = 20000) {
    const t0 = Date.now();
    let resolveLoad;
    const loaded = new Promise((r) => { resolveLoad = r; });
    this._onLoad = () => resolveLoad(true);
    const nav = await this.send('Page.navigate', { url });
    if (nav.errorText) { this.navError = nav.errorText; }
    const ok = await Promise.race([loaded, sleep(loadTimeout).then(() => false)]);
    this.loadMs = Date.now() - t0;
    this.loadTimedOut = !ok;
    return ok;
  }

  async scrollPass() {
    for (const f of [0, 0.5, 1, 0]) {
      try {
        await this.eval(`window.scrollTo(0, Math.max(0, (document.documentElement.scrollHeight - innerHeight) * ${f}))`, { timeout: 4000 });
      } catch { /* 無視 */ }
      await sleep(1000);
    }
  }

  async screenshot(file, { full = false } = {}) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const params = { format: 'png' };
    if (full) {
      try {
        const m = await this.send('Page.getLayoutMetrics');
        const h = Math.min(Math.ceil(m.cssContentSize?.height || m.contentSize.height), 3500);
        params.captureBeyondViewport = true;
        params.clip = { x: 0, y: 0, width: 1366, height: Math.max(h, 800), scale: 1 };
      } catch { /* 無視 */ }
    }
    const r = await withTimeout(this.send('Page.captureScreenshot', params), 15000, 'スクリーンショットがタイムアウト');
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  }

  /** 通信の集計。ブロック / 差し替え(拡張機能の redirect)/ 通過 の 3 分類 */
  netSummary(pageUrl) {
    let pageHost = '';
    try { pageHost = new URL(pageUrl).hostname; } catch { /* 無視 */ }
    const pageReg = registrable(pageHost);
    const byStatus = {};
    let total = 0, blocked = 0, replaced = 0, replacedThird = 0, passed = 0, passedThird = 0, failedOther = 0, third = 0, thirdBlocked = 0;
    const H = () => new Map();
    const thirdPassed = H(), thirdBlockedHosts = H(), replacedHosts = H();
    const ex = new Map(); // host -> Set(パス)。通過ホストの URL 例
    const rex = new Map();
    const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
    const addEx = (m, host, u) => { const set = m.get(host) || new Set(); if (set.size < 2) set.add(stripQuery(u)); m.set(host, set); };
    for (const r of this.requests.values()) {
      if (!/^https?:/i.test(r.url)) continue;
      let host = '';
      try { host = new URL(r.url).hostname; } catch { continue; }
      total++;
      const isThird = registrable(host) !== pageReg;
      if (isThird) third++;
      if (r.replaced) {
        replaced++;
        byStatus['replaced'] = (byStatus['replaced'] || 0) + 1;
        if (isThird) replacedThird++;
        bump(replacedHosts, host); addEx(rex, host, r.url);
      } else if (r.blocked) {
        blocked++;
        if (isThird) { thirdBlocked++; bump(thirdBlockedHosts, host); }
        byStatus['blocked'] = (byStatus['blocked'] || 0) + 1;
      } else if (r.failed) {
        failedOther++;
        byStatus['failed'] = (byStatus['failed'] || 0) + 1;
      } else if (r.status != null) {
        const k = Math.floor(r.status / 100) + 'xx';
        byStatus[k] = (byStatus[k] || 0) + 1;
        passed++;
        if (isThird) { passedThird++; bump(thirdPassed, host); addEx(ex, host, r.url); }
      } else {
        byStatus['pending'] = (byStatus['pending'] || 0) + 1;
      }
    }
    const top = (m, n, exm) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
      .map(([host, count]) => ({ host, count, ...(exm ? { examples: [...(exm.get(host) || [])] } : {}) }));
    return {
      total, blocked, replaced, replacedThird, passed, passedThird, failedOther, byStatus,
      thirdPartyRequests: third, thirdPartyBlocked: thirdBlocked,
      thirdPartyPassedHosts: thirdPassed.size,
      topPassedThirdParty: top(thirdPassed, 15, ex),
      topBlockedThirdParty: top(thirdBlockedHosts, 10),
      topReplaced: top(replacedHosts, 10, rex),
    };
  }

  /** 失敗・ブロック・差し替えになったリクエスト一覧(クエリを除く) */
  problemRequests() {
    const out = [];
    for (const r of this.requests.values()) {
      if (!/^https?:/i.test(r.url)) continue;
      if (r.replaced) out.push({ kind: 'replaced', url: stripQuery(r.url), to: stripQuery(r.replacedTo || ''), type: r.type });
      else if (r.failed) out.push({ kind: r.blocked ? 'blocked' : 'failed', url: stripQuery(r.url), error: r.errorText, type: r.type });
    }
    return out;
  }

  /** ネットワークに出た script の URL(ブロックされたものも含む) */
  scriptUrls() {
    return [...new Set([...this.requests.values()].filter((r) => r.type === 'Script' && /^https?:/i.test(r.url)).map((r) => r.url))];
  }

  async close() {
    for (const off of this.offs) off();
    try { await withTimeout(this.b.send('Target.closeTarget', { targetId: this.targetId }), 3000); } catch { /* 無視 */ }
  }
}

/**
 * 通常サイトの計測。
 * @returns 計測結果(エラー時は error を含む)
 */
export async function measureSite(browser, site, { settle = 8, shotFile, hardTimeout = 45000 }) {
  const page = new Page(browser);
  const result = { url: site.url, category: site.category };
  const t0 = Date.now();
  const work = (async () => {
    await page.open();
    await page.navigate(site.url, 20000);
    result.loadMs = page.loadMs;
    result.loadTimedOut = page.loadTimedOut;
    if (page.navError) result.navError = page.navError;
    await sleep(settle * 1000);
    await page.scrollPass();
    await sleep(500);
    const dom = await page.eval(PAGE_PROBE, { timeout: 8000 });
    Object.assign(result, { dom });
    if (shotFile) {
      try { await page.screenshot(shotFile); result.shot = shotFile; } catch (e) { result.shotError = e.message; }
    }
  })();
  try {
    await withTimeout(work, hardTimeout, `サイト計測が ${hardTimeout / 1000} 秒でタイムアウト`);
  } catch (e) {
    result.error = e.message;
  }
  // 途中までの結果も残す(タイムアウト時でも通信は集計する)
  result.net = page.netSummary(result.dom?.finalUrl || site.url);
  result.console = { errors: page.consoleErrors, networkErrors: page.networkLogErrors, samples: page.errorSamples };
  result.elapsedMs = Date.now() - t0;
  await page.close();
  return result;
}

/** 広告ブロック検出ページの計測。detector = {name,url,expr} */
export async function measureDetector(browser, det, { shotFile, detailDir, hardTimeout = 60000 }) {
  const page = new Page(browser);
  const result = { name: det.name, url: det.url, category: 'detector' };
  const t0 = Date.now();
  const work = (async () => {
    await page.open();
    await page.navigate(det.url, 15000);
    result.loadMs = page.loadMs;
    // 結果が出るまで最大 20 秒待つ
    let out = null;
    const tEnd = Date.now() + (det.maxWait || 20) * 1000;
    while (Date.now() < tEnd) {
      await sleep(1000);
      try {
        out = await page.eval(det.expr, { timeout: 5000 });
        if (out && out.done) break;
      } catch (e) { out = { done: false, text: '', error: e.message }; }
    }
    result.done = !!(out && out.done);
    result.text = out?.text ?? '';
    result.score = out?.score ?? null;
    result.pct = out?.pct ?? null;
    result.items = out?.items ?? null;
    result.waitedMs = Date.now() - t0;
    try { await page.screenshot(shotFile, { full: true }); result.shot = shotFile; } catch (e) { result.shotError = e.message; }
    if (detailDir) {
      try {
        fs.mkdirSync(detailDir, { recursive: true });
        fs.writeFileSync(path.join(detailDir, 'console.json'), JSON.stringify(page.consoleLog, null, 2));
        fs.writeFileSync(path.join(detailDir, 'problem-requests.json'), JSON.stringify(page.problemRequests(), null, 2));
        if (det.saveScripts) result.scripts = await saveScripts(page, path.join(detailDir, 'scripts'));
        result.detailDir = detailDir;
      } catch (e) { result.detailError = e.message; }
    }
  })();
  try {
    await withTimeout(work, hardTimeout, `検出ページ計測が ${hardTimeout / 1000} 秒でタイムアウト`);
  } catch (e) { result.error = e.message; }
  result.net = page.netSummary(det.url);
  result.elapsedMs = Date.now() - t0;
  await page.close();
  return result;
}

/** ページが読み込む inline / 外部スクリプトのソースを 30KB まで保存する(検出ロジックを読むため) */
async function saveScripts(page, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const dom = await page.eval('[...document.scripts].map((s) => ({ src: s.src, text: s.src ? "" : s.textContent.slice(0, 30000) }))', { timeout: 8000 });
  const list = [];
  const seen = new Set();
  for (const d of dom) {
    if (d.src) { if (seen.has(d.src)) continue; seen.add(d.src); list.push({ src: d.src }); } else list.push({ inline: d.text });
  }
  for (const u of page.scriptUrls()) if (!seen.has(u)) { seen.add(u); list.push({ src: u, fromNetwork: true }); }
  const index = [];
  let n = 0;
  for (const it of list) {
    n++;
    const name = String(n).padStart(2, '0') + '_' + (it.src ? slugify(it.src) : 'inline') + '.js';
    let body = '', status = null;
    if (it.src) {
      try {
        const r = await withTimeout(fetch(it.src, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36' } }), 10000, 'fetch timeout');
        status = r.status;
        body = (await r.text()).slice(0, 30000);
      } catch (e) { body = '// 取得できませんでした: ' + e.message; }
    } else body = it.inline;
    fs.writeFileSync(path.join(dir, name), body);
    index.push({ file: name, src: it.src || null, inline: !it.src, bytes: body.length, status });
  }
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(index, null, 2));
  return index;
}
