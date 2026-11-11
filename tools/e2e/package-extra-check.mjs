// 公開用パッケージの追加確認。package-check.mjs が見ていない次の項目を、実機のブラウザーで確かめる。
//   node tools/e2e/package-extra-check.mjs [--ext <dir>] [--browser chrome|edge]
//   (d) 設定画面で、自動更新の項目が隠れ、ほかの設定が見えて、保存できる
//   (e) ポップアップ画面(popup/popup.html)に「このタブで止めた件数」が出る(getMatchedRules)
//   (g) $popup のフィルター(127.0.0.1 → localhost)でポップアップのタブが閉じる(webNavigation)
//   (h) スクリプレット(MAIN world の content script)の登録件数
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

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK ' : 'NG '} ${name}${detail ? ` … ${detail}` : ''}`);
};

const { browser: b } = await launchWithExtension({ extSrc, methods, log: console.log });
console.log(`起動: ${b.version}（${b.methodName}）拡張機能 ID ${b.extId}`);

const evIn = (sessionId) => async (expression) => {
  const r = await b.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};
async function attachSw() {
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    const { targetInfos } = await b.send('Target.getTargets');
    const sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${b.extId}/`));
    if (sw) return (await b.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true })).sessionId;
    await sleep(500);
  }
  throw new Error('service worker が見つかりません');
}
async function openTab(url, pre) {
  const { targetId } = await b.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await b.send('Target.attachToTarget', { targetId, flatten: true });
  await b.send('Page.enable', {}, sessionId);
  if (pre) await b.send('Page.addScriptToEvaluateOnNewDocument', { source: pre }, sessionId);
  await b.send('Page.navigate', { url }, sessionId);
  await sleep(2500);
  return { targetId, sessionId, ev: evIn(sessionId) };
}

const servers = [];
const listen = (host) => new Promise((resolve) => {
  const s = http.createServer((req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end(`<!doctype html><title>${req.url}</title><body>${req.url}</body>`); });
  servers.push(s);
  if (host) s.listen(0, host, () => resolve(s.address().port)); else s.listen(0, () => resolve(s.address().port));
});

try {
  const sw = await attachSw();
  const ev = evIn(sw);

  // ---- (h) スクリプレット ----
  const n = await ev('chrome.scripting.getRegisteredContentScripts().then(r => r.length)');
  const worlds = await ev('chrome.scripting.getRegisteredContentScripts().then(r => [...new Set(r.map(s => s.world))])');
  check('(h) MAIN world の content script が登録されている', n >= 15 && worlds.includes('MAIN'), `${n} 件 / world: ${worlds.join(',')}`);

  // ---- (d) 設定画面 ----
  const opts = await openTab(`chrome-extension://${b.extId}/options/options.html`);
  await sleep(1500);
  const ui = await opts.ev(`(() => {
    const vis = (id) => { const e = document.getElementById(id); return !!e && e.offsetParent !== null; };
    return { autoReload: vis('autoReload'), others: ['collapseSlots', 'collapsePromo', 'youtubePrune', 'pvDiagEnabled', 'allowlist', 'customFilters', 'save'].map((i) => [i, vis(i)]),
      lists: document.querySelectorAll('[data-ruleset]').length, hiddenDev: [...document.querySelectorAll('[data-dev-update]')].filter((e) => e.offsetParent !== null).length,
      text: document.body.innerText.includes('自動で取り込む') };
  })()`);
  check('(d) 自動更新のチェックボックスと説明が表示されない', !ui.autoReload && ui.hiddenDev === 0 && !ui.text, JSON.stringify({ autoReload: ui.autoReload, hiddenDev: ui.hiddenDev, text: ui.text }));
  check('(d) ほかの設定（チェックボックス・許可リスト・自分のフィルター・保存）が表示されている', ui.others.every(([, v]) => v), JSON.stringify(ui.others));
  check('(d) リストの一覧が 10 件', ui.lists === 10, `${ui.lists} 件`);
  await opts.ev(`(() => { const c = document.getElementById('collapseSlots'); c.checked = !c.checked; document.getElementById('allowlist').value = 'example.org'; document.getElementById('customFilters').value = '||ad-test.invalid^'; document.getElementById('save').click(); })()`);
  await sleep(1200);
  const saved = await ev('chrome.storage.local.get(["allowlist","customFilters","collapseSlots","autoReload"])');
  const status = await opts.ev(`document.getElementById('status').textContent`);
  check('(d) 保存できる（chrome.storage.local に反映）', JSON.stringify(saved.allowlist) === '["example.org"]' && saved.customFilters === '||ad-test.invalid^' && typeof saved.collapseSlots === 'boolean', `${status} / ${JSON.stringify(saved)}`);
  await ev('chrome.storage.local.remove(["allowlist","customFilters","collapseSlots","autoReload"])');
  await b.send('Target.closeTarget', { targetId: opts.targetId }).catch(() => {});

  // ---- (e) ポップアップ画面の件数 ----
  const portA = await listen('127.0.0.1');
  const site = await openTab('https://example.com/');
  await site.ev(`new Promise((res) => { const s = document.createElement('script'); s.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js'; s.onload = s.onerror = () => res(1); document.body.appendChild(s); const i = document.createElement('iframe'); i.src = 'https://googleads.g.doubleclick.net/pagead/ads?client=x'; document.body.appendChild(i); setTimeout(res, 3000); })`);
  await sleep(1500);
  const tabId = await ev(`chrome.tabs.query({}).then(ts => ts.find(t => t.url && t.url.startsWith('https://example.com/'))?.id)`);
  // ポップアップ画面を普通のタブとして開くと「アクティブなタブ」が自分自身になるので、tabs.query だけ差し替える
  const stub = `chrome.tabs.query = async () => [{ id: ${tabId}, url: 'https://example.com/' }];`;
  const pop = await openTab(`chrome-extension://${b.extId}/popup/popup.html`, stub);
  await sleep(1500);
  const count = await pop.ev(`document.getElementById('count').textContent`);
  const direct = await ev(`chrome.declarativeNetRequest.getMatchedRules({ tabId: ${tabId} }).then(r => r.rulesMatchedInfo.length)`);
  check('(e) ポップアップ画面が開き、「このタブで止めた件数」が出る', /^\d+$/.test(count) && Number(count) > 0, `表示 ${count} / getMatchedRules ${direct} 件 (tab ${tabId})`);
  await b.send('Target.closeTarget', { targetId: pop.targetId }).catch(() => {});
  await b.send('Target.closeTarget', { targetId: site.targetId }).catch(() => {});

  // ---- (g) ポップアップ広告のブロック(127.0.0.1 → localhost) ----
  const portB = await listen(null);
  const run = async (label, expectClosed) => {
    const opener = await openTab(`http://127.0.0.1:${portA}/`);
    await opener.ev(`(window.__w = window.open('http://localhost:${portB}/ad', '_blank'), true)`);
    await sleep(5000);
    const closed = await opener.ev('window.__w ? window.__w.closed : null');
    const { targetInfos } = await b.send('Target.getTargets');
    const adTabs = targetInfos.filter((t) => t.type === 'page' && t.url.includes(`localhost:${portB}/ad`));
    check(`(g) ${label}`, expectClosed ? closed === true && adTabs.length === 0 : closed === false && adTabs.length === 1, `closed=${closed} 残りのタブ=${adTabs.length}`);
    for (const t of adTabs) await b.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
    await b.send('Target.closeTarget', { targetId: opener.targetId }).catch(() => {});
  };
  await run('フィルター無しでは localhost のポップアップは閉じられない(対照)', false);
  await ev(`chrome.storage.local.set({ customFilters: '||localhost^$popup,domain=127.0.0.1' })`);
  await sleep(1500);
  await run('||localhost^$popup,domain=127.0.0.1 でポップアップのタブが閉じる', true);
  await ev(`chrome.storage.local.remove('customFilters')`);
} finally {
  for (const s of servers) s.close();
  await b.close();
}
const ng = results.filter((r) => !r.ok);
console.log(`\n${results.length - ng.length}/${results.length} 件 OK。${ng.length ? 'NG: ' + ng.map((r) => r.name).join(' / ') : ''}`);
process.exitCode = ng.length ? 1 : 0;
