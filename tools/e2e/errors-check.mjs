// ADBAN の「拡張機能のエラー」(chrome://extensions のエラー画面に出るもの)を、サイトを開いて集計する。
// 使い方: node tools/e2e/errors-check.mjs [--sites <json>] [--only <語,語>] [--limit N] [--settle 秒] [--concurrency N] [--ext <dir>] [--out <dir>]
//  - 既定は tools/e2e/sites.json の先頭 20 サイト。--only はカテゴリ名または URL の一部(カンマ区切り)。
//  - --ext は読み込む拡張機能のディレクトリ(既定はリポジトリのルート)。直す前のコピーと比べるときに使う。
// 仕組み: chrome://extensions のページで chrome.developerPrivate を呼んで取り出す(開発者モードを入れ、
//   エラーの収集を有効にする。この Chrome の使い捨てプロファイルだけの設定)。
//   service worker の Runtime.exceptionThrown は content script / MAIN world のエラーを拾えないので使わない。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep, withTimeout } from './lib/browser.mjs';
import { Manager } from './lib/manager.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const extSrc = path.resolve(opt('ext', path.resolve(HERE, '..', '..')));
const sitesFile = path.resolve(opt('sites', path.join(HERE, 'sites.json')));
const only = (opt('only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const limit = Number(opt('limit', 20));
const settleMs = Number(opt('settle', 6)) * 1000;
const concurrency = Number(opt('concurrency', 3));
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = path.resolve(opt('out', path.join(HERE, 'out', stamp + '_errors')));
fs.mkdirSync(outDir, { recursive: true });

let sites = JSON.parse(fs.readFileSync(sitesFile, 'utf8'));
if (only.length) sites = sites.filter((s) => only.some((o) => s.category === o || s.url.includes(o)));
sites = sites.slice(0, limit);
console.log(`対象 ${sites.length} サイト / 拡張機能: ${extSrc}`);

const mgr = new Manager({ mode: 'adban', extSrc, log: console.log });
const b = await mgr.get();

// ---- エラー画面(chrome://extensions)から取り出す ----
const { targetId: extPageTarget } = await b.send('Target.createTarget', { url: 'chrome://extensions/' });
const { sessionId: extSession } = await b.send('Target.attachToTarget', { targetId: extPageTarget, flatten: true });
await sleep(1500);
async function evExt(expr) {
  const r = await b.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, extSession);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
}
await evExt('chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode: true})');
await sleep(500);
const collecting = await evExt(`chrome.developerPrivate.getExtensionInfo('${b.extId}').then(i => i.errorCollection.isEnabled)`);
if (!collecting) throw new Error('エラーの収集を有効にできませんでした');
await evExt(`chrome.developerPrivate.deleteExtensionErrors({extensionId: '${b.extId}'})`); // 起動時の分は数えない
const readErrors = () => evExt(`chrome.developerPrivate.getExtensionInfo('${b.extId}').then(i => ({ runtime: i.runtimeErrors, manifest: i.manifestErrors }))`);

// ---- サイトを順に開く ----
const perSite = [];
async function visit(site) {
  const t0 = Date.now();
  const { targetId } = await b.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await b.send('Target.attachToTarget', { targetId, flatten: true });
  let note = '';
  try {
    await b.send('Page.enable', {}, sessionId);
    await b.send('Network.setUserAgentOverride', { userAgent: b.userAgent, acceptLanguage: 'ja-JP,ja,en-US,en' }, sessionId).catch(() => {});
    await b.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId).catch(() => {});
    const loaded = new Promise((res) => { const off = b.on(sessionId, 'Page.loadEventFired', () => { off(); res(); }); });
    await b.send('Page.navigate', { url: site.url }, sessionId);
    await withTimeout(loaded, 20000, 'load').catch(() => { note = 'load タイムアウト'; });
    await sleep(settleMs);
    for (const y of [0.5, 1, 0]) { // 遅延読み込みの通信を起こす
      await b.send('Runtime.evaluate', { expression: `scrollTo(0, document.documentElement.scrollHeight * ${y})` }, sessionId).catch(() => {});
      await sleep(800);
    }
  } catch (e) {
    note = String(e.message || e);
  }
  try { await b.send('Target.closeTarget', { targetId }); } catch { /* 無視 */ }
  perSite.push({ url: site.url, ms: Date.now() - t0, note });
  console.log(`  ${site.url} ${note ? '(' + note + ')' : ''}`);
}
const queue = sites.slice();
await Promise.all(Array.from({ length: Math.max(1, concurrency) }, async () => {
  while (queue.length && b.alive) { await visit(queue.shift()); }
}));
await sleep(1500);
const { runtime, manifest } = await readErrors();
await mgr.close();

// ---- 分類と集計 ----
const FETCH_MSG = /Failed to fetch|NetworkError|Load failed|network error|The user aborted a request|signal is aborted|AbortError/i;
const stripExt = (u) => String(u).replace(/^chrome-extension:\/\/[a-p]{32}\//, '');
const frameName = (f) => (f ? `${stripExt(f.url)}:${f.lineNumber}` : '(スタックなし)');
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return String(u); } };
function classify(e) {
  const top = e.stackTrace?.[0];
  const topFile = top ? stripExt(top.url) : '';
  if (e.type === 'MANIFEST') return 'manifest';
  if (topFile === 'content/scriptlets.js' && FETCH_MSG.test(e.message)) return 'page-fetch';
  if (topFile === 'content/scriptlets.js') return 'page-other-via-scriptlets';
  return 'adban-own';
}
const LABEL = {
  'page-fetch': 'ページ側の fetch / XHR の失敗(scriptlets.js の Proxy 経由)',
  'page-other-via-scriptlets': 'ページ側のその他の例外(scriptlets.js の Proxy 経由。要確認)',
  'adban-own': 'ADBAN 自身のエラー(scriptlets.js 以外)',
  manifest: 'manifest のエラー',
};
const all = [...manifest.map((e) => ({ ...e, type: 'MANIFEST' })), ...runtime.map((e) => ({ ...e, type: e.type === 'MANIFEST' ? 'MANIFEST' : 'RUNTIME' }))];
const groups = new Map();
for (const e of all) {
  const cat = classify(e);
  const key = [cat, e.message, frameName(e.stackTrace?.[0])].join('\u0000');
  const g = groups.get(key) || { category: cat, type: e.type, message: e.message, source: frameName(e.stackTrace?.[0]), count: 0, entries: 0, sites: new Set(), contexts: [] };
  g.count += e.occurrences || 1; g.entries += 1;
  g.sites.add(hostOf(e.contextUrl || e.source));
  if (g.contexts.length < 3) g.contexts.push(e.contextUrl || e.source);
  groups.set(key, g);
}
const rows = [...groups.values()].map((g) => ({ ...g, sites: [...g.sites] })).sort((a, b2) => b2.count - a.count);
const byCat = {};
for (const r of rows) { byCat[r.category] ||= { count: 0, groups: 0 }; byCat[r.category].count += r.count; byCat[r.category].groups += 1; }
const total = rows.reduce((t, r) => t + r.count, 0);

const result = { extSrc, sites: sites.length, total, byCategory: byCat, rows, perSite, raw: all };
fs.writeFileSync(path.join(outDir, 'errors-check.json'), JSON.stringify(result, null, 2));
const md = [];
md.push('# ADBAN 拡張機能エラーの集計', '', `- 拡張機能: ${extSrc}`, `- 開いたサイト: ${sites.length}`, `- エラー合計(発生回数): ${total} / 種類: ${rows.length}`, '');
md.push('## 分類別', '');
for (const [k, v] of Object.entries(byCat)) md.push(`- ${LABEL[k]}: ${v.count} 件(${v.groups} 種類)`);
md.push('', '## 内訳', '', '| 件数 | 分類 | 種類 | メッセージ | ソース | サイト |', '|---|---|---|---|---|---|');
for (const r of rows) md.push(`| ${r.count} | ${r.category} | ${r.type} | ${r.message.replace(/\|/g, '\\|').slice(0, 140)} | ${r.source} | ${r.sites.slice(0, 6).join(', ')}${r.sites.length > 6 ? ` 他${r.sites.length - 6}` : ''} |`);
fs.writeFileSync(path.join(outDir, 'errors-check.md'), md.join('\n') + '\n');

console.log(`\nエラー合計 ${total} 件(${rows.length} 種類)`);
for (const [k, v] of Object.entries(byCat)) console.log(`  ${LABEL[k]}: ${v.count} 件(${v.groups} 種類)`);
for (const r of rows.slice(0, 30)) console.log(`  [${r.count}] ${r.category} | ${r.message.slice(0, 100)} | ${r.source} | ${r.sites.slice(0, 4).join(',')}`);
console.log(`出力: ${outDir}`);
process.exit(0);
