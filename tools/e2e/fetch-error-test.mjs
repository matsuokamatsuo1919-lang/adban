// ページ側の fetch が失敗したとき、ADBAN の「拡張機能のエラー」に記録されるかと、ページから見た振る舞いが
// 拡張機能なしと同じかを、127.0.0.1 の簡易サーバーのテストページで確かめる。
// 使い方: node tools/e2e/fetch-error-test.mjs [--ext <dir>] [--repeat N] [--registered] [--verbose]
//  - --ext: 試す拡張機能のディレクトリ(既定はリポジトリのルート)。直す前のコピーと比べるときに使う。
// 仕組み:
//  1. 拡張機能のコピーに、テスト専用の content script(MAIN world・document_start・127.0.0.1 だけ)を足す。
//     scriptlets の表(と YouTube 用の yt-main.js)に xml-prune(.mpd)・json-prune-fetch-response・prevent-fetch を入れ、content/scriptlets.js を動かす。
//  2. 拡張機能なしの Chrome と、拡張機能ありの Chrome で同じテストページを開き、ページ側で記録した結果(順序・値・例外)を比べる。
//  3. 拡張機能ありの Chrome では chrome://extensions のエラー(chrome.developerPrivate)の件数も数える。
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser, copyExtension, rmDirSafe, sleep } from './lib/browser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const extSrc = path.resolve(opt('ext', path.resolve(HERE, '..', '..')));
const repeat = Number(opt('repeat', 1));
const registered = argv.includes('--registered'); // manifest ではなく、background.js と同じ chrome.scripting.registerContentScripts で注入する

// ---- 簡易サーバー ----
const MPD = '<?xml version="1.0"?><MPD mediaPresentationDuration="PT10S"><Period id="main-1"/><Period id="roll-ad"/></MPD>';
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/page') { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(PAGE); return; }
  if (url === '/ok.json') { res.setHeader('content-type', 'application/json'); res.end('{"a":1,"ads":[1,2]}'); return; }
  if (url === '/ad.mpd') { res.setHeader('content-type', 'application/dash+xml'); res.end(MPD); return; }
  if (url === '/reset' || url === '/reset.mpd' || url === '/reset.json') { req.socket.destroy(); return; } // 通信を切って fetch を失敗させる
  if (url === '/bad.json') { res.setHeader('content-type', 'application/json'); res.end('{bad'); return; }
  if (url === '/slow') { return; } // 応答しない(abort の確認用)
  res.statusCode = 404; res.end('not found');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const pageUrl = `http://127.0.0.1:${port}/page`;

// ---- テストページ(ページ側で結果を window.__result に入れる) ----
const PAGE = `<!doctype html><meta charset="utf-8"><title>fetch-error-test</title><script>
(async () => {
  const R = { order: [], scen: {}, unhandled: [] };
  const log = (s) => R.order.push(s);
  const mask = (s) => String(s || '').replace(/chrome-extension:\\/\\/[a-p]{32}/g, 'chrome-extension://ID').replace(/127\\.0\\.0\\.1:\\d+/g, 'HOST');
  const info = (e) => ({
    isError: e instanceof Error, isDom: e instanceof DOMException, name: e && e.name, message: mask(e && e.message),
    stack: mask(e && e.stack), desc: (() => { const d = Object.getOwnPropertyDescriptor(e, 'stack'); return d ? Object.keys(d).sort().join(',') + ':' + [d.writable, d.enumerable, d.configurable].join('/') : 'none'; })(),
    extFrames: String((e && e.stack) || '').split('\\n').filter((l) => l.includes('chrome-extension://')).length,
  });
  const P = {};
  addEventListener('unhandledrejection', (ev) => {
    const name = Object.keys(P).find((k) => P[k] === ev.promise) || '?';
    log('unhandledrejection:' + name);
    R.unhandled.push({ name, reason: info(ev.reason) });
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));

  // 1) 失敗する fetch を catch しない
  P.uncaught = fetch('/reset'); // 何も付けない
  await sleep(1500);
  R.scen.uncaught = { done: true };

  // 2) 失敗する fetch を catch する(複数の観察者の順序・同一性)
  {
    const p = fetch('/reset');
    let first = null;
    p.catch((e) => { log('catch1'); first = e; R.scen.caught1 = info(e); });
    p.then(() => log('then-ok'), (e) => { log('then-rej2'); R.scen.sameReason = e === first; });
    p.finally(() => log('finally3'));
    R.scen.isPromise = p instanceof Promise && Object.getPrototypeOf(p) === Promise.prototype && p.constructor === Promise;
    Promise.resolve().then(() => log('micro1')).then(() => log('micro2')).then(() => log('micro3'));
    await sleep(1500);
  }

  // 3) 正常な fetch
  {
    const r = await fetch('/ok.json');
    R.scen.ok = { status: r.status, ok: r.ok, type: r.type, redirected: r.redirected, url: mask(r.url), json: await r.json(), ctor: r.constructor.name };
  }

  // 4) 対象 URL(.mpd)の fetch(成功)。xml-prune により本文は変わるのが正しい
  {
    const r = await fetch('/ad.mpd');
    R.scen.mpdOk = { status: r.status, type: r.type, url: mask(r.url), text: await r.text() };
  }

  // 5) 対象 URL(.mpd)の fetch(失敗・catch する)
  {
    const p = fetch('/reset.mpd');
    const s = await settle(p);
    R.scen.mpdBad = s.ok ? { ok: true } : info(s.e);
  }
  // 5b) 対象 URL の失敗を catch しない
  P.mpdUncaught = fetch('/reset.mpd');
  await sleep(1500);

  // 6) 引数が不正で、呼び出した時点で拒否される(同期的に拒否済みの Promise)
  {
    const a = settle(fetch());
    const b = settle(fetch('http://['));
    const [ra, rb] = await Promise.all([a, b]);
    R.scen.noArgs = ra.ok ? { ok: true } : info(ra.e);
    R.scen.badUrl = rb.ok ? { ok: true } : info(rb.e);
  }

  // 7) 順序: 拒否済みの Promise に付けた catch と、別の Promise の反応の前後
  {
    const seq = [];
    const p = fetch();
    p.catch(() => seq.push('fetch-catch'));
    Promise.reject(1).catch(() => seq.push('plain-catch'));
    Promise.resolve().then(() => seq.push('micro'));
    await sleep(50);
    R.scen.syncOrder = seq;
  }

  // 8) abort
  {
    const ac = new AbortController();
    const p = fetch('/slow', { signal: ac.signal });
    ac.abort();
    const s = await settle(p);
    R.scen.abort = s.ok ? { ok: true } : info(s.e);
  }
  // 9) YouTube 用の MAIN world スクリプト(yt-main.js)の Response.json / JSON.parse の例外
  {
    const r = await fetch('/bad.json');
    P.jsonUncaught = r.json(); // catch しない
    await sleep(500);
    try { JSON.parse('{bad'); } catch (e) { R.scen.jsonParse = info(e); }
    const r2 = await fetch('/bad.json');
    const s = await settle(r2.json());
    R.scen.jsonCaught = s.ok ? { ok: true } : info(s.e);
  }
  // 10) 見た目
  R.scen.fn = { name: fetch.name, length: fetch.length, str: Function.prototype.toString.call(fetch) };
  await sleep(300);
  window.__result = R;
})();
</script>`;

// ---- ブラウザ ----
const TABLE = {
  entries: [
    ['xml-prune', 'Period[id$="-ad"]', '', '.mpd'],
    ['json-prune-fetch-response', 'ads', '', 'propsToMatch', '/ok.json'],
    ['prevent-fetch', '/never-requested'],
  ],
  add: { '127.0.0.1': [0, 1, 2] },
  remove: {},
};

function makeTestExtension() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adban-fetchtest-ext-'));
  copyExtension(extSrc, dir);
  fs.mkdirSync(path.join(dir, 'e2e-test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'e2e-test', 'table.js'), `(self.__adbanScriptlets ||= []).push(${JSON.stringify(TABLE)});\n`);
  const mp = path.join(dir, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  if (!registered) m.content_scripts.push({
    matches: ['http://127.0.0.1/*'], js: ['e2e-test/table.js', 'content/scriptlets.js', 'content/yt-main.js'],
    run_at: 'document_start', all_frames: true, world: 'MAIN',
  });
  fs.writeFileSync(mp, JSON.stringify(m, null, 2));
  return dir;
}

async function runPage(b, withErrors) {
  const { targetId } = await b.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await b.send('Target.attachToTarget', { targetId, flatten: true });
  await b.send('Page.enable', {}, sessionId);
  await b.send('Runtime.enable', {}, sessionId);
  await b.send('Page.navigate', { url: pageUrl }, sessionId);
  let result = null;
  for (let i = 0; i < 60 && !result; i++) {
    await sleep(500);
    const r = await b.send('Runtime.evaluate', { expression: 'JSON.stringify(window.__result || null)', returnByValue: true }, sessionId).catch(() => null);
    result = r?.result?.value ? JSON.parse(r.result.value) : null;
  }
  try { await b.send('Target.closeTarget', { targetId }); } catch { /* 無視 */ }
  return result;
}

async function extErrors(b) {
  const { targetId } = await b.send('Target.createTarget', { url: 'chrome://extensions/' });
  const { sessionId } = await b.send('Target.attachToTarget', { targetId, flatten: true });
  await sleep(1500);
  const ev = async (expr) => {
    const r = await b.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  };
  return { ev, close: () => b.send('Target.closeTarget', { targetId }).catch(() => {}) };
}

async function oneRun() {
  // baseline(拡張機能なし)
  const base = new Browser({ browser: 'chrome', extDir: null, method: 'pipe', headless: true });
  await base.launch();
  const baseResult = await runPage(base, false);
  await base.close();

  // 拡張機能あり
  const dir = makeTestExtension();
  const ext = new Browser({ browser: 'chrome', extDir: dir, method: 'pipe', headless: true });
  ext.extCopy = dir;
  await ext.launch();
  if (registered) {
    const { targetInfos } = await ext.send('Target.getTargets');
    const sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${ext.extId}/`));
    const { sessionId } = await ext.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
    const r = await ext.send('Runtime.evaluate', { expression: `chrome.scripting.registerContentScripts([{ id: 'e2e-test', matches: ['http://127.0.0.1/*'], js: ['e2e-test/table.js', 'content/scriptlets.js', 'content/yt-main.js'], world: 'MAIN', runAt: 'document_start', allFrames: true }]).then(() => 'ok')`, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error('registerContentScripts: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
  }
  const page = await extErrors(ext);
  await page.ev('chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode: true})');
  await sleep(500);
  await page.ev(`chrome.developerPrivate.deleteExtensionErrors({extensionId: '${ext.extId}'})`);
  const extResult = await runPage(ext, true);
  await sleep(1500);
  const errs = await page.ev(`chrome.developerPrivate.getExtensionInfo('${ext.extId}').then(i => i.runtimeErrors.concat(i.manifestErrors))`);
  await ext.close();
  return { baseResult, extResult, errs };
}

// ---- 比較 ----
const stripBody = (r) => {
  const c = JSON.parse(JSON.stringify(r));
  delete c.scen.mpdOk; // 本文は xml-prune で変わるのが正しい(別に表示する)
  delete c.scen.ok.json; // json-prune-fetch-response で変わるのが正しい
  return c;
};
function diff(a, b, p = '') {
  const out = [];
  if (typeof a !== typeof b || (a && typeof a === 'object') !== (b && typeof b === 'object')) return [`${p}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`];
  if (a && typeof a === 'object') {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) out.push(...diff(a[k], b[k], `${p}.${k}`));
    return out;
  }
  return a === b ? [] : [`${p}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`];
}

for (let i = 0; i < repeat; i++) {
  const { baseResult, extResult, errs } = await oneRun();
  console.log(`\n===== 実行 ${i + 1}/${repeat}(拡張機能: ${extSrc})=====`);
  if (!baseResult || !extResult) { console.log('テストページの結果が取れませんでした', !!baseResult, !!extResult); continue; }
  const d = diff(stripBody(baseResult), stripBody(extResult));
  console.log(d.length ? `ページから見た違い(拡張機能なし -> あり)${d.length} 件:\n  ` + d.join('\n  ') : 'ページから見た違い: なし(順序・値・例外・unhandledrejection・stack の extension フレームまで同じ)');
  console.log('xml-prune の本文(.mpd):', JSON.stringify(baseResult.scen.mpdOk.text), '->', JSON.stringify(extResult.scen.mpdOk.text));
  console.log('拡張機能なしの順序:', baseResult.order.join(' > '));
  console.log('拡張機能ありの順序:', extResult.order.join(' > '));
  console.log(`拡張機能のエラー: ${errs.length} 件`);
  for (const e of errs) console.log(`  [${e.occurrences}] ${e.message} | ${e.stackTrace?.[0] ? String(e.stackTrace[0].url).replace(/^chrome-extension:\/\/[a-p]{32}\//, '') + ':' + e.stackTrace[0].lineNumber : '(スタックなし)'}`);
  if (process.argv.includes('--verbose')) console.log(JSON.stringify({ baseResult, extResult }, null, 1));
}
server.close();
process.exit(0);
