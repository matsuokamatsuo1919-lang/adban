// バッジの件数と、ポップアップの「ブロック件数」(getMatchedRules) を実機で確かめる（公開版の権限の確認用）。
//   node tools/e2e/badge-check.mjs [--ext <dir>] [--browser chrome|edge]
//   --ext の既定は dist/package。declarativeNetRequestFeedback を外した版を指定すると、何が動かなくなるかが分かる。
// 確かめること:
//   (1) 広告の通信（googleads.g.doubleclick.net など）を止めたあと、そのタブのバッジの文字（chrome.action.getBadgeText）が件数になる
//   (2) ポップアップ広告を閉じると、バッジが 1 つ増える（popup-blocker.js の tabUpdate increment）
//   (3) getMatchedRules({ tabId }) が使えるか（ポップアップ画面の件数。declarativeNetRequestFeedback が要る）
// 既存の tools/e2e/ のファイルは変更していない。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchWithExtension, sleep } from './lib/browser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const extSrc = path.resolve(opt('ext', path.resolve(HERE, '..', '..', 'dist', 'package')));
const browserName = opt('browser', 'chrome');
const methods = browserName === 'edge'
  ? [{ browser: 'edge', method: 'flag' }, { browser: 'edge', method: 'pipe' }]
  : [{ browser: 'chrome', method: 'pipe' }, { browser: 'chrome', method: 'flag' }];

const manifest = JSON.parse(fs.readFileSync(path.join(extSrc, 'manifest.json'), 'utf8'));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'OK ' : 'NG '} ${name}${detail ? ` … ${detail}` : ''}`);
};
console.log(`拡張機能: ${extSrc}（権限: ${manifest.permissions.join(', ')}）/ ブラウザー: ${browserName}`);

const { browser: b } = await launchWithExtension({ extSrc, methods, log: console.log });
const evIn = (sessionId) => async (expression) => {
  const r = await b.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};
async function attachSw() {
  for (let i = 0; i < 60; i++) {
    const { targetInfos } = await b.send('Target.getTargets');
    const sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${b.extId}/`));
    if (sw) return (await b.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true })).sessionId;
    await sleep(500);
  }
  throw new Error('service worker が見つかりません');
}

const page = `<!doctype html><title>badge</title><body>x<script>
  window.run = async () => {
    const urls = ['https://googleads.g.doubleclick.net/pagead/ads?client=ca-pub-1', 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js', 'https://www.googletagservices.com/tag/js/gpt.js'];
    const out = [];
    for (const u of urls) out.push(await fetch(u, { mode: 'no-cors' }).then(() => 'ok', () => 'blocked'));
    return out;
  };
</script></body>`;
const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(page); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

try {
  const ev = evIn(await attachSw());
  await ev(`chrome.storage.local.set({ customFilters: '||popup-ad.test^$popup' })`);
  await sleep(1500);
  const { targetId } = await b.send('Target.createTarget', { url });
  const { sessionId } = await b.send('Target.attachToTarget', { targetId, flatten: true });
  await sleep(2500);
  const evPage = evIn(sessionId);
  const fetched = await evPage('window.run()');
  console.log(`  ページから 3 件の広告通信: ${JSON.stringify(fetched)}`);
  check('広告の通信が止められる（3 件とも blocked）', fetched.every((x) => x === 'blocked'));
  await sleep(1500);

  const tab = await ev(`chrome.tabs.query({ url: '${url}*' }).then((t) => t.map((x) => x.id))`);
  const tabId = tab[0];
  const badge1 = await ev(`chrome.action.getBadgeText({ tabId: ${tabId} })`);
  console.log(`  バッジ（通信を止めたあと）: "${badge1}"`);
  check('バッジの件数が出る（1 以上）', Number(badge1) >= 1, `"${badge1}"`);

  const gm = await ev(`chrome.declarativeNetRequest.getMatchedRules({ tabId: ${tabId} }).then((r) => ({ ok: true, n: r.rulesMatchedInfo.length }), (e) => ({ ok: false, error: String(e.message) }))`);
  console.log(`  getMatchedRules({tabId}): ${JSON.stringify(gm)}`);
  check('getMatchedRules が使えて、件数が 1 以上（ポップアップ画面の件数）', gm.ok && gm.n >= 1, JSON.stringify(gm));

  await evPage(`(window.__w = window.open('http://popup-ad.test/ad', '_blank'), true)`);
  await sleep(4000);
  const badge2 = await ev(`chrome.action.getBadgeText({ tabId: ${tabId} })`);
  console.log(`  バッジ（ポップアップを閉じたあと）: "${badge2}"`);
  check('ポップアップ広告を閉じると、バッジが 1 つ増える', Number(badge2) === Number(badge1) + 1, `"${badge1}" → "${badge2}"`);
  const closed = await evPage('window.__w ? window.__w.closed : null');
  check('ポップアップが閉じられている', closed === true);
  await ev(`chrome.storage.local.remove('customFilters')`);
} finally {
  server.close();
  await b.close();
}
const ng = results.filter((r) => !r.ok);
console.log(`\n${results.length - ng.length}/${results.length} 件 OK。${ng.length ? `NG: ${ng.map((r) => r.name).join(' / ')}` : ''}`);
process.exitCode = ng.length ? 1 : 0;
