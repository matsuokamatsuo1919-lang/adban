// 「ページ側のスクリプトから、ADBAN の存在が見つかる痕跡」を、拡張機能なし・ありの差として測る。
// 使い方: node tools/e2e/stealth-test.mjs [--ext <dir>] [--verbose] [--json <file>]
//  - --ext: 試す拡張機能のディレクトリ(既定はリポジトリのルート)。直す前のコピーと比べるときに使う。
//  - --verbose: 差のある項目の「なし -> あり」の値を全部出す(既定は先頭 160 文字まで)。
// 仕組み(fetch-error-test.mjs と同じ):
//  1. 拡張機能のコピーに、テスト専用の content script(MAIN world・document_start・127.0.0.1 だけ)を足し、
//     スクリプレット(fetch・XMLHttpRequest・JSON.parse・setTimeout・eval・window.open など、組み込みを包むもの)を一通り動かす。
//  2. 拡張機能なしの Chrome と、ありの Chrome で同じテストページを開く。ページの最初の script と、load の後の 2 回、
//     組み込みの関数・クラスの見た目(toString / name / length / ディスクリプター)、グローバルの名前、DOM、stack、
//     chrome-extension:// の URL を記録する。
//  3. 2 つの記録を同じ項目ごとに比べ、差のある項目を重大度つきで出す。差が 0 件なら「見分けがつかない」。
// 差の項目数が少ないほど、広告ブロッカー検出に見つかりにくい。
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser, copyExtension, sleep } from './lib/browser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const extSrc = path.resolve(opt('ext', path.resolve(HERE, '..', '..')));
const verbose = argv.includes('--verbose');
const jsonOut = opt('json', null);

// ---- 簡易サーバー ----
const MPD = '<?xml version="1.0"?><MPD><Period id="main-1"/><Period id="roll-ad"/></MPD>';
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/page') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(PAGE); return; }
  if (url === '/ok.json') { res.setHeader('content-type', 'application/json'); res.end('{"a":1,"ads":[1,2]}'); return; }
  if (url === '/ad.mpd') { res.setHeader('content-type', 'application/dash+xml'); res.end(MPD); return; }
  res.statusCode = 404; res.end('not found');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const pageUrl = `http://127.0.0.1:${port}/page`;

// ---- テストページ ----
// 記録は { 項目名: 文字列 } の平らな表にする(比べやすいように)。
const PAGE = `<!doctype html><meta charset="utf-8"><title>stealth-test</title>
<script>
(() => {
  const R = { early: {}, late: {}, redirect: {} };
  window.__stealth = R;
  const mask = (s) => String(s)
    .replace(/chrome-extension:\\/\\/[a-p]{32}/g, 'chrome-extension://ID')
    .replace(/127\\.0\\.0\\.1:\\d+/g, 'HOST')
    .replace(/(inline-\\d+\\.js):\\d+:\\d+/g, '$1:L:C');
  const FTS = Function.prototype.toString;
  const call = (f, ...a) => Function.prototype.call.call(f, ...a);
  const safe = (fn) => { try { return fn(); } catch (e) { return 'THROW ' + (e && e.name) + ': ' + mask(e && e.message); } };

  // ---- 関数・クラスの見た目 ----
  const describeFn = (out, label, f) => {
    if (typeof f !== 'function') { out[label + '|typeof'] = typeof f; return; }
    out[label + '|toString.call'] = safe(() => FTS.call(f));
    out[label + '|.toString()'] = safe(() => f.toString());
    out[label + '|String()'] = safe(() => String(f));
    out[label + '|name'] = safe(() => JSON.stringify(f.name));
    out[label + '|length'] = safe(() => f.length);
    out[label + '|ownKeys'] = safe(() => Reflect.ownKeys(f).map(String).join(','));
    out[label + '|hasOwn toString'] = safe(() => Object.hasOwn(f, 'toString'));
    out[label + '|has prototype'] = safe(() => 'prototype' in f);
    out[label + '|prototype keys'] = safe(() => f.prototype ? Reflect.ownKeys(f.prototype).map(String).join(',') : '-');
    out[label + '|proto of fn'] = safe(() => { const p = Object.getPrototypeOf(f); return p === Function.prototype ? 'Function.prototype' : (p && p.name) || String(p); });
    out[label + '|Object.prototype.toString'] = safe(() => Object.prototype.toString.call(f));
    out[label + '|prototype desc'] = safe(() => { const d = Object.getOwnPropertyDescriptor(f, 'prototype'); return d ? [d.writable, d.enumerable, d.configurable].join('/') : '-'; });
  };
  const describeDesc = (out, label, holder, key) => {
    const d = safe(() => Object.getOwnPropertyDescriptor(holder, key));
    if (typeof d === 'string') { out[label + '|desc'] = d; return; }
    if (!d) { out[label + '|desc'] = 'none'; return; }
    out[label + '|desc'] = ['get' in d ? 'accessor' : 'data', d.writable, d.enumerable, d.configurable].join('/');
    if ('value' in d) describeFn(out, label, d.value);
    if (d.get) describeFn(out, label + ' [get]', d.get);
    if (d.set) describeFn(out, label + ' [set]', d.set);
  };
  const globalsOf = () => Object.getOwnPropertyNames(window).sort().join(',');

  const TARGETS = [
    ['fetch', window, 'fetch'], ['XMLHttpRequest', window, 'XMLHttpRequest'],
    ['JSON.parse', JSON, 'parse'], ['setTimeout', window, 'setTimeout'], ['setInterval', window, 'setInterval'],
    ['eval', window, 'eval'], ['requestAnimationFrame', window, 'requestAnimationFrame'], ['window.open', window, 'open'],
    ['getComputedStyle', window, 'getComputedStyle'], ['RTCPeerConnection', window, 'RTCPeerConnection'],
    ['Element.getBoundingClientRect', Element.prototype, 'getBoundingClientRect'],
    ['EventTarget.addEventListener', EventTarget.prototype, 'addEventListener'],
    ['Function.prototype.toString', Function.prototype, 'toString'],
    ['Object.defineProperty', Object, 'defineProperty'], ['Object.getOwnPropertyDescriptor', Object, 'getOwnPropertyDescriptor'],
    ['document.createElement', Document.prototype, 'createElement'],
    ['Element.querySelector', Element.prototype, 'querySelector'], ['Element.setAttribute', Element.prototype, 'setAttribute'],
    ['Element.getAttribute', Element.prototype, 'getAttribute'], ['Element.removeAttribute', Element.prototype, 'removeAttribute'],
    ['Element.matches', Element.prototype, 'matches'], ['Node.textContent', Node.prototype, 'textContent'],
    ['Response.json', Response.prototype, 'json'], ['Response.text', Response.prototype, 'text'],
    ['Request', window, 'Request'], ['Response', window, 'Response'], ['Promise', window, 'Promise'],
    ['Promise.then', Promise.prototype, 'then'], ['Reflect.apply', Reflect, 'apply'], ['Error.captureStackTrace', Error, 'captureStackTrace'],
    ['MutationObserver', window, 'MutationObserver'],
  ];
  // XMLHttpRequest.prototype の全メンバー
  const xhrKeys = () => Reflect.ownKeys(XMLHttpRequest.prototype).filter((k) => typeof k === 'string');

  const probeStatic = (out) => {
    out['globals'] = globalsOf();
    for (const [label, holder, key] of TARGETS) {
      if (!holder) { out[label + '|holder'] = 'missing'; continue; }
      describeDesc(out, label, holder, key);
    }
    out['XMLHttpRequest.prototype keys'] = safe(() => Reflect.ownKeys(XMLHttpRequest.prototype).map(String).join(','));
    for (const k of safe(xhrKeys) || []) describeDesc(out, 'XHR.prototype.' + k, XMLHttpRequest.prototype, k);
    out['XMLHttpRequest static keys'] = safe(() => Reflect.ownKeys(XMLHttpRequest).map(String).join(','));
    out['XMLHttpRequest.prototype === (new XHR).__proto__'] = safe(() => { const x = new XMLHttpRequest(); return Object.getPrototypeOf(x) === XMLHttpRequest.prototype; });
    out['XHR instanceof XHR'] = safe(() => new XMLHttpRequest() instanceof XMLHttpRequest);
    out['XHR.constructor === XHR'] = safe(() => new XMLHttpRequest().constructor === XMLHttpRequest);
    out['XHR toString tag'] = safe(() => Object.prototype.toString.call(new XMLHttpRequest()));
    out['XHR super name'] = safe(() => { const p = Object.getPrototypeOf(XMLHttpRequest); return p === Function.prototype ? 'Function.prototype' : p.name; });
    out['XHR.prototype proto name'] = safe(() => Object.getPrototypeOf(XMLHttpRequest.prototype).constructor.name);
    out['XHR own keys of instance'] = safe(() => Reflect.ownKeys(new XMLHttpRequest()).map(String).join(','));
    out['XHR.DONE'] = safe(() => XMLHttpRequest.DONE);
    out['Function.prototype.toString self-toString'] = safe(() => Function.prototype.toString.toString());
    out['Function.prototype.toString.call(toString)'] = safe(() => FTS.call(Function.prototype.toString));
    out['toString.call({}) error'] = safe(() => Function.prototype.toString.call({}));
    out['toString.call(undefined) error'] = safe(() => Function.prototype.toString.call(undefined));
    out['toString.call(Proxy of function)'] = safe(() => FTS.call(new Proxy(function foo() {}, {})));
    out['toString.call(class)'] = safe(() => FTS.call(class Foo { x() {} }));
    out['toString.call(bound)'] = safe(() => FTS.call(function foo() {}.bind(null)));
    out['toString.call(Symbol)'] = safe(() => FTS.call(Symbol));
  };

  // ---- stack ----
  const stackOf = (fn) => { try { fn(); } catch (e) { return mask(e && e.stack); } return 'no throw'; };
  const probeStacks = (out) => {
    const cases = {
      'JSON.parse SyntaxError': () => JSON.parse('{bad'),
      'setTimeout no args': () => setTimeout(),
      'getComputedStyle(null)': () => getComputedStyle(null),
      'addEventListener no args': () => document.addEventListener(),
      'XHR.open no args': () => new XMLHttpRequest().open(),
      'XHR.open bad url': () => new XMLHttpRequest().open('GET', 'http://['),
      'XHR.send before open': () => new XMLHttpRequest().send(),
      'XHR.responseText sync read of async': () => { const x = new XMLHttpRequest(); x.open('GET', '/ok.json'); x.responseType = 'json'; return x.responseText; },
      'eval syntax': () => eval('{'),
      'window.open bad': () => window.open(Symbol()),
      'getBoundingClientRect illegal': () => Element.prototype.getBoundingClientRect.call({}),
      'toString illegal': () => Function.prototype.toString.call({}),
      'Reflect.apply bad': () => Reflect.apply(1),
      'fetch bad type sync': () => { fetch(); },
    };
    for (const [k, f] of Object.entries(cases)) {
      const s = stackOf(f);
      out['stack|' + k + '|lines'] = s.split('\\n').length;
      out['stack|' + k + '|ext frames'] = s.split('\\n').filter((l) => /chrome-extension:|inline-\\d+\\.js/.test(l)).length;
      out['stack|' + k + '|text'] = s;
    }
    // 成功する呼び出しの途中(reviver・コールバック)から見える stack
    out['stack|JSON.parse reviver'] = (() => { let s = ''; JSON.parse('{"a":1}', function (k) { if (!s) s = mask(new Error().stack); return this[k]; }); return s; })();
    // Error.captureStackTrace / prepareStackTrace
    out['captureStackTrace|JSON.parse reviver'] = (() => {
      let s = ''; JSON.parse('{"a":1}', function (k) { if (!s) { const o = {}; Error.captureStackTrace(o); s = mask(o.stack); } return this[k]; }); return s;
    })();
    out['prepareStackTrace|JSON.parse reviver'] = (() => {
      const old = Error.prepareStackTrace; let names = [];
      Error.prepareStackTrace = (e, sites) => { names = sites.map((c) => mask(String(c.getFileName()) + '#' + String(c.getFunctionName()) + '#' + String(c.getTypeName()))); return ''; };
      try { JSON.parse('{"a":1}', function (k) { if (!names.length) void new Error().stack; return this[k]; }); } finally { Error.prepareStackTrace = old; }
      return names.join(' <- ');
    })();
    out['prepareStackTrace|fetch syncthrow'] = (() => {
      const old = Error.prepareStackTrace; let names = [];
      Error.prepareStackTrace = (e, sites) => { names = sites.map((c) => mask(String(c.getFileName()) + '#' + String(c.getFunctionName()))); return ''; };
      try { try { getComputedStyle(null); } catch (e) { void e.stack; } } finally { Error.prepareStackTrace = old; }
      return names.join(' <- ');
    })();
    out['Error.stackTraceLimit'] = Error.stackTraceLimit;
    out['Error.prepareStackTrace default'] = String(Error.prepareStackTrace);
    out['stack own desc'] = (() => { const d = Object.getOwnPropertyDescriptor(new Error('x'), 'stack'); return d ? Object.keys(d).sort().join(',') : 'none'; })();
  };

  // ---- DOM ----
  const probeDom = (out) => {
    const de = document.documentElement;
    out['outerHTML masked (ext 由来の語)'] = (() => {
      const html = de.outerHTML;
      const hits = html.match(/adban|chrome-extension|data-adban|__adban/gi) || [];
      return hits.join(',');
    })();
    out['DOM element count'] = document.querySelectorAll('*').length;
    out['DOM attribute names'] = (() => {
      const names = new Set();
      for (const el of document.querySelectorAll('*')) for (const a of el.attributes) names.add(a.name);
      return [...names].sort().join(',');
    })();
    out['DOM tag names'] = (() => { const t = new Set(); for (const el of document.querySelectorAll('*')) t.add(el.localName); return [...t].sort().join(','); })();
    out['html/head/body attrs'] = [de, document.head, document.body].map((e) => e ? [...e.attributes].map((a) => a.name).join('+') : '-').join('|');
    out['styleSheets'] = document.styleSheets.length;
    out['adoptedStyleSheets'] = document.adoptedStyleSheets.length;
    out['styleSheets text hits'] = (() => {
      let hits = 0;
      for (const s of document.styleSheets) { try { for (const r of s.cssRules) if (/adban|chrome-extension/i.test(r.cssText)) hits++; } catch {} }
      return hits;
    })();
    out['script elements'] = document.scripts.length;
    out['elements named adban'] = [...document.querySelectorAll('*')].filter((e) => /adban/i.test(e.localName + e.id + e.className)).length;
    out['chrome-extension in src/href'] = [...document.querySelectorAll('[src],[href]')].filter((e) => /chrome-extension:/.test((e.getAttribute('src') || '') + (e.getAttribute('href') || ''))).length;
    out['resource timing chrome-extension'] = performance.getEntriesByType('resource').filter((e) => e.name.startsWith('chrome-extension:')).map((e) => mask(e.name)).join(',');
    out['resource timing count'] = performance.getEntriesByType('resource').length;
    out['MO records'] = R.mo.join(' ; ');
    out['MO adban-named'] = R.mo.filter((s) => /adban|mark/i.test(s)).length;
  };

  // MutationObserver を最初から仕掛ける(ADBAN が一時的に付ける属性・要素を拾う)
  R.mo = [];
  new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'attributes') R.mo.push('attr:' + r.target.nodeName + ':' + r.attributeName);
      else for (const n of r.addedNodes) if (n.nodeType === 1 && n.localName !== 'script') R.mo.push('add:' + n.nodeName);
    }
  }).observe(document, { attributes: true, childList: true, subtree: true });

  const snapshot = (name) => { const out = R[name]; probeStatic(out); probeStacks(out); probeDom(out); };
  snapshot('early');

  // XHR / fetch の動作確認(挙動が同じことの確認用)
  const behave = {};
  R.behave = behave;
  window.addEventListener('load', async () => {
    try {
      // fetch: 正常・成功の中身
      const r = await fetch('/ok.json');
      behave.fetchOk = { status: r.status, url: mask(r.url), type: r.type, body: JSON.stringify(await r.json()) };
      const m = await fetch('/ad.mpd');
      behave.fetchMpd = { url: mask(m.url), text: await m.text() };
      // XHR: 正常
      const x = new XMLHttpRequest();
      await new Promise((res) => { x.onload = res; x.onerror = res; x.open('GET', '/ok.json'); x.send(); });
      behave.xhr = { readyState: x.readyState, status: x.status, text: x.responseText, response: x.response, url: mask(x.responseURL) };
      const x2 = new XMLHttpRequest();
      await new Promise((res) => { x2.onload = res; x2.onerror = res; x2.open('GET', '/ad.mpd'); x2.send(); });
      behave.xhrMpd = { text: x2.responseText };
      // 偽の応答に差し替える先(広告のスクリプトなど)の見え方
      const rd = R.redirect;
      const probeUrl = 'https://www.google-analytics.com/analytics.js';
      rd.scriptResult = await new Promise((res) => {
        const s = document.createElement('script'); s.src = probeUrl; s.onload = () => res('load'); s.onerror = () => res('error');
        document.head.appendChild(s); setTimeout(() => res('timeout'), 8000);
      });
      rd.fetchResult = await fetch(probeUrl).then((r) => mask(JSON.stringify({ url: r.url, redirected: r.redirected, type: r.type, status: r.status })), (e) => 'rejected ' + e.name + ': ' + mask(e.message));
      rd.entries = performance.getEntriesByType('resource').filter((e) => e.name.includes('google-analytics')).map((e) => mask(JSON.stringify({ name: e.name, initiatorType: e.initiatorType, transferSize: e.transferSize, decodedBodySize: e.decodedBodySize })));
      rd.windowHasGA = typeof window.ga + '/' + typeof window.GoogleAnalyticsObject;
    } catch (e) { behave.error = String(e); }
    await new Promise((r) => setTimeout(r, 500));
    snapshot('late');
    window.__done = true;
  });
})();
</script>`;

// ---- 拡張機能のコピーに、テスト専用の表を足す ----
const TABLE = {
  entries: [
    ['xml-prune', 'Period[id$="-ad"]', '', '.mpd'],
    ['json-prune-fetch-response', 'ads', '', 'propsToMatch', '/ok.json'],
    ['prevent-fetch', '/never-requested'],
    ['prevent-xhr', '/never-xhr'],
    ['json-prune-xhr-response', 'ads', '', 'propsToMatch', '/ok.json'],
    ['json-prune', 'neverPruneMe'],
    ['prevent-setTimeout', 'neverMatch1234'],
    ['prevent-setInterval', 'neverMatch1234'],
    ['adjust-setTimeout', 'neverMatch1234'],
    ['no-window-open-if', 'neverMatch1234'],
    ['noeval-if', 'neverMatch1234'],
    ['prevent-requestAnimationFrame', 'neverMatch1234'],
    ['spoof-css', '.never-match', 'display', 'block'],
    ['nowebrtc'],
    ['addEventListener-defuser', 'neverMatchType', 'x'],
  ],
  add: { '127.0.0.1': [...Array(15).keys()] },
  remove: {},
};

function makeTestExtension() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adban-stealth-ext-'));
  copyExtension(extSrc, dir);
  fs.mkdirSync(path.join(dir, 'e2e-test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'e2e-test', 'table.js'), `(self.__adbanScriptlets ||= []).push(${JSON.stringify(TABLE)});\n`);
  const mp = path.join(dir, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  m.content_scripts.push({
    matches: ['http://127.0.0.1/*'], js: ['e2e-test/table.js', 'content/scriptlets.js'],
    run_at: 'document_start', all_frames: true, world: 'MAIN',
  });
  fs.writeFileSync(mp, JSON.stringify(m, null, 2));
  return dir;
}

async function runPage(b) {
  const { targetId } = await b.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await b.send('Target.attachToTarget', { targetId, flatten: true });
  await b.send('Page.enable', {}, sessionId);
  await b.send('Runtime.enable', {}, sessionId);
  await b.send('Page.navigate', { url: pageUrl }, sessionId);
  let result = null;
  for (let i = 0; i < 80 && !result; i++) {
    await sleep(500);
    const r = await b.send('Runtime.evaluate', { expression: 'window.__done ? JSON.stringify(window.__stealth) : null', returnByValue: true }, sessionId).catch(() => null);
    result = r?.result?.value ? JSON.parse(r.result.value) : null;
  }
  try { await b.send('Target.closeTarget', { targetId }); } catch { /* 無視 */ }
  return result;
}

async function measure(extDir) {
  const b = new Browser({ browser: 'chrome', extDir, method: 'pipe', headless: true });
  if (extDir) b.extCopy = extDir;
  await b.launch();
  const r = await runPage(b);
  await b.close();
  return r;
}

// ---- 比較と重大度 ----
// 検出に使われやすい順: 高 = 1 行の toString / 名前の確認で見つかる、中 = グローバル・DOM・stack を丁寧に調べると見つかる、低 = ほとんど使われない
const severityOf = (key) => {
  if (/\|toString\.call|\|\.toString\(\)|\|String\(\)|^Function\.prototype\.toString|toString\.call\(|toString self/.test(key)) return '高';
  if (/\|name$|\|length$|\|ownKeys|\|hasOwn toString|\|desc$|has prototype|prototype keys|XHR|XMLHttpRequest/.test(key)) return '高';
  if (/^globals$|DOM|MO |outerHTML|styleSheets|script elements|custom elements|chrome-extension|resource timing/.test(key)) return '中';
  if (/^stack\||captureStackTrace|prepareStackTrace|stack own/.test(key)) return '中';
  return '低';
};
const cut = (v) => { const s = typeof v === 'string' ? v : String(JSON.stringify(v)); return verbose || s.length <= 160 ? s : s.slice(0, 160) + '…'; };

function compare(base, ext) {
  const diffs = [];
  for (const phase of ['early', 'late']) {
    const keys = new Set([...Object.keys(base[phase]), ...Object.keys(ext[phase])]);
    for (const k of keys) {
      const a = base[phase][k]; const b = ext[phase][k];
      if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push({ phase, key: k, base: a, ext: b, severity: severityOf(k) });
    }
  }
  return diffs;
}

const baseResult = await measure(null);
const dir = makeTestExtension();
const extResult = await measure(dir);
server.close();
if (!baseResult || !extResult) { console.log('テストページの結果が取れませんでした', !!baseResult, !!extResult); process.exit(1); }

const diffs = compare(baseResult, extResult);
console.log(`拡張機能: ${extSrc}`);
const bySev = { '高': [], '中': [], '低': [] };
for (const d of diffs) bySev[d.severity].push(d);
const keysTotal = Object.keys(baseResult.early).length + Object.keys(baseResult.late).length;
console.log(`\n差のある項目: ${diffs.length} 件(調べた項目 ${keysTotal} 件中)  高 ${bySev['高'].length} / 中 ${bySev['中'].length} / 低 ${bySev['低'].length}`);
for (const sev of ['高', '中', '低']) {
  if (!bySev[sev].length) continue;
  console.log(`\n[重大度 ${sev}]`);
  for (const d of bySev[sev]) console.log(`  (${d.phase}) ${d.key}\n      なし: ${cut(d.base)}\n      あり: ${cut(d.ext)}`);
}
// 挙動の確認(拡張機能による本文の書き換えは、json-prune-xhr-response / xml-prune の意図した結果)
console.log('\n[挙動の確認(なし -> あり)]');
console.log(' ', JSON.stringify(baseResult.behave));
console.log(' ', JSON.stringify(extResult.behave));
console.log('\n[偽のリソースへの置き換えの見え方(ネットワークがあるとなしの側は本物が読まれる)]');
console.log('  なし:', JSON.stringify(baseResult.redirect));
console.log('  あり:', JSON.stringify(extResult.redirect));
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ baseResult, extResult, diffs }, null, 1));
process.exit(0);
