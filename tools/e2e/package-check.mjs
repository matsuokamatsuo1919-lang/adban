// 公開用パッケージ（node tools/make-package.mjs が作る dist/package/）を、実際のブラウザーに読み込んで確かめる。
//   node tools/e2e/package-check.mjs [--ext <dir>] [--browser chrome|edge] [--out <dir>]
//   --ext      読み込むパッケージのディレクトリ（既定は dist/package）。開発用のフォルダーを指定すると、比較用（対照）になる
//   --browser  chrome（既定）または edge
//
// 確かめること:
//   (a) 読み込めて、service worker が起動し、manifest のエラー・警告・実行時のエラーがない（拡張機能を再読み込みして、起動時のエラーも拾う）
//   (b) 有効なルールセットと、実際に読み込まれた静的ルールの数が、パッケージの rules/ の合計と一致する
//   (d) alarms・idle の権限がないのに、service worker が例外を出さない（chrome.alarms・chrome.idle は未定義）
//   (e) $popup のフィルターに当たるポップアップが閉じられ、当たらないものは閉じられない / 設定画面の自動更新のチェックボックスが隠れている
//   ほか: ポップアップの件数に使う getMatchedRules が使える
// 既存の tools/e2e/ のファイルは変更していない。ブラウザーの起動は lib/browser.mjs を使う。
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
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = path.resolve(opt('out', path.join(HERE, 'out', `${stamp}_package-${browserName}`)));
fs.mkdirSync(outDir, { recursive: true });

const manifest = JSON.parse(fs.readFileSync(path.join(extSrc, 'manifest.json'), 'utf8'));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK ' : 'NG '} ${name}${detail ? ` … ${detail}` : ''}`);
};

console.log(`パッケージ: ${extSrc}（v${manifest.version}）/ ブラウザー: ${browserName}`);
const { browser: b } = await launchWithExtension({ extSrc, methods, log: console.log });
const info = { version: b.version, method: b.methodName, ext: b.extInfo };
console.log(`起動: ${b.version}（${b.methodName}）拡張機能 ID ${b.extId}、登録済みスクリプト ${b.extInfo?.registeredScripts} 件、準備まで ${b.extInfo?.readyMs}ms`);

async function attachSw() {
  const t0 = Date.now();
  while (Date.now() - t0 < 30000) {
    const { targetInfos } = await b.send('Target.getTargets');
    const sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${b.extId}/`));
    if (sw) {
      const { sessionId } = await b.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
      return sessionId;
    }
    await sleep(500);
  }
  throw new Error('service worker が見つかりません');
}
const evIn = (sessionId) => async (expression) => {
  const r = await b.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
};

let sw = await attachSw();
let ev = evIn(sw);

try {
  // ---- (a) 読み込めた ----
  const name = await ev('chrome.runtime.getManifest().name');
  check('(a) 拡張機能が読み込まれ、service worker が起動している', name === 'ADBAN', `${name} v${await ev('chrome.runtime.getManifest().version')}`);
  check('(a) 内容スクリプトが登録されている（service worker の起動時の処理が最後まで動いた）', (b.extInfo?.registeredScripts ?? 0) > 0, `${b.extInfo?.registeredScripts} 件`);

  // ---- (d) 権限 ----
  const perms = await ev('chrome.runtime.getManifest().permissions');
  const types = await ev('({ alarms: typeof chrome.alarms, idle: typeof chrome.idle, webNavigation: typeof chrome.webNavigation })');
  const wantNoAlarms = !manifest.permissions.includes('alarms');
  console.log(`  権限: ${perms.join(', ')} / 型: ${JSON.stringify(types)}`);
  if (wantNoAlarms) {
    check('(d) chrome.alarms・chrome.idle が未定義（権限なし）', types.alarms === 'undefined' && types.idle === 'undefined');
  } else {
    check('(対照) alarms・idle の権限がある開発用の版', types.alarms === 'object' && types.idle === 'object');
  }
  check('(d) webNavigation は使える（popup-blocker.js）', types.webNavigation === 'object');

  // ---- manifest・実行時のエラー（拡張機能の再読み込みで、起動時のエラーも拾う） ----
  const { targetId: extPageTarget } = await b.send('Target.createTarget', { url: 'chrome://extensions/' });
  const { sessionId: extPage } = await b.send('Target.attachToTarget', { targetId: extPageTarget, flatten: true });
  await sleep(1500);
  const evExt = evIn(extPage);
  await evExt('chrome.developerPrivate.updateProfileConfiguration({inDeveloperMode: true})');
  await sleep(500);
  const readInfo = () => evExt(`chrome.developerPrivate.getExtensionInfo('${b.extId}').then(i => ({ manifestErrors: i.manifestErrors, runtimeErrors: i.runtimeErrors, installWarnings: i.installWarnings, errorCollection: i.errorCollection.isEnabled, state: i.state }))`);
  const before = await readInfo();
  await evExt(`chrome.developerPrivate.deleteExtensionErrors({extensionId: '${b.extId}'})`);
  await evExt(`chrome.developerPrivate.reload('${b.extId}', {failQuietly: true, populateErrorForUnpacked: true})`);
  await sleep(1000);
  // 再読み込みのあと、service worker が起動し直して、内容スクリプトが登録されるのを待つ
  sw = await attachSw();
  ev = evIn(sw);
  for (let i = 0; i < 60; i++) {
    const n = await ev('chrome.scripting.getRegisteredContentScripts().then(r => r.length)').catch(() => 0);
    if (n > 0) break;
    await sleep(500);
  }
  await sleep(6000); // 起動後の処理（ルールの切り替え・スクリプレットの登録）が終わるまで
  const after = await readInfo();
  const errs = [...after.manifestErrors, ...after.runtimeErrors].map((e) => `${e.type ?? ''} ${e.message ?? e.source ?? JSON.stringify(e)}`.trim());
  check('(a) manifest にエラーがない（読み込み時・再読み込み後）', before.manifestErrors.length === 0 && after.manifestErrors.length === 0, JSON.stringify([...before.manifestErrors, ...after.manifestErrors].map((e) => e.message)));
  check('(a) 警告（installWarnings）がない', (before.installWarnings?.length ?? 0) === 0 && (after.installWarnings?.length ?? 0) === 0, JSON.stringify(after.installWarnings?.map((w) => w.message)));
  check('(d) 起動時（再読み込み後）の service worker に実行時のエラーがない', after.errorCollection && after.runtimeErrors.length === 0, errs.join(' | ') || `エラーの収集 ${after.errorCollection ? 'オン' : 'オフ'}`);
  check('(a) 再読み込み後も有効', after.state === 'ENABLED', after.state);

  // ---- (b) ルール ----
  const files = {};
  for (const rr of manifest.declarative_net_request.rule_resources) files[rr.id] = JSON.parse(fs.readFileSync(path.join(extSrc, rr.path), 'utf8')).length;
  const ids = Object.keys(files);
  const fileTotal = Object.values(files).reduce((t, n) => t + n, 0);
  const enabled = await ev('chrome.declarativeNetRequest.getEnabledRulesets()');
  check('(b) 有効なルールセットが manifest の全部と一致', JSON.stringify([...enabled].sort()) === JSON.stringify([...ids].sort()), `${enabled.length} 個: ${enabled.join(',')}`);
  check('(b) ペーターロウのルールセットが無い（公開版）', manifest.permissions.includes('alarms') || !enabled.includes('peterlowe'));
  // 起動直後は service worker 自身がルールセットを切り替えていることがある(Edge は遅く、測定と重なって数が狂った)。
  // 有効なルールセットの数が 2 秒変わらなくなってから測る
  for (let i = 0, last = '', since = Date.now(); i < 40; i++) {
    const cur = JSON.stringify(await ev('chrome.declarativeNetRequest.getEnabledRulesets()'));
    if (cur !== last) { last = cur; since = Date.now(); } else if (Date.now() - since >= 2000) break;
    await sleep(400);
  }
  await ev(`chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: ${JSON.stringify(ids)} })`);
  const avail0 = await ev('chrome.declarativeNetRequest.getAvailableStaticRuleCount()');
  const per = [];
  for (const id of ids) {
    await ev(`chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: [${JSON.stringify(id)}] })`);
    const loaded = avail0 - (await ev('chrome.declarativeNetRequest.getAvailableStaticRuleCount()'));
    await ev(`chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: [${JSON.stringify(id)}] })`);
    per.push({ id, file: files[id], loaded });
  }
  await ev(`chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: ${JSON.stringify(ids)} })`);
  const availAll = await ev('chrome.declarativeNetRequest.getAvailableStaticRuleCount()');
  const loadedTotal = per.reduce((t, p) => t + p.loaded, 0);
  for (const p of per) console.log(`    ${p.id.padEnd(12)} ファイル ${String(p.file).padStart(6)} / 読み込み ${String(p.loaded).padStart(6)} ${p.file === p.loaded ? '' : '←差あり'}`);
  check('(b) 読み込まれた静的ルールの数が rules/ の合計と一致（ルールセットごと）', per.every((p) => p.file === p.loaded), `合計 ファイル ${fileTotal} / 読み込み ${loadedTotal}`);
  check('(b) 全部有効にしたときの数も一致', avail0 - availAll === fileTotal, `${avail0 - availAll} / ${fileTotal}`);
  const matched = await ev(`chrome.declarativeNetRequest.testMatchOutcome({ url: 'https://googleads.g.doubleclick.net/pagead/ads?client=ca-pub-1', initiator: 'https://example.com', type: 'sub_frame' })`);
  check('(b) 代表的な広告のホストにルールが当たる（testMatchOutcome）', (matched.matchedRules ?? []).length > 0, JSON.stringify(matched.matchedRules));

  // ---- getMatchedRules（ポップアップの件数。declarativeNetRequestFeedback） ----
  const gm = await ev('chrome.declarativeNetRequest.getMatchedRules({}).then(r => ({ ok: true, n: r.rulesMatchedInfo.length }), e => ({ ok: false, error: String(e.message) }))');
  check('ポップアップの件数に使う getMatchedRules が使える', gm.ok, JSON.stringify(gm));

  // ---- (e) 設定画面: 自動更新のチェックボックス ----
  const { targetId: optTarget } = await b.send('Target.createTarget', { url: `chrome-extension://${b.extId}/options/options.html` });
  const { sessionId: optPage } = await b.send('Target.attachToTarget', { targetId: optTarget, flatten: true });
  await sleep(2000);
  const evOpt = evIn(optPage);
  const ui = await evOpt(`(() => {
    const box = document.getElementById('autoReload');
    const els = [...document.querySelectorAll('[data-dev-update]')];
    return { hasBox: !!box, boxVisible: !!box && box.offsetParent !== null, devElements: els.length, visible: els.filter((e) => e.offsetParent !== null).length, listCount: document.querySelectorAll('[data-ruleset]').length, text: document.body.innerText.includes('自動で取り込む') };
  })()`);
  console.log(`  設定画面: ${JSON.stringify(ui)}`);
  if (wantNoAlarms) {
    check('(e) 設定画面の「リストの更新を自動で取り込む」が表示されない', ui.hasBox && !ui.boxVisible && ui.visible === 0 && !ui.text, JSON.stringify(ui));
  } else {
    check('(対照) 開発用の版では「リストの更新を自動で取り込む」が表示される', ui.boxVisible && ui.visible === ui.devElements);
  }
  check('(e) 設定画面のリストの数が manifest のルールセットと同じ', ui.listCount === ids.length, `${ui.listCount} 件`);
  await b.send('Target.closeTarget', { targetId: optTarget }).catch(() => {});

  // ---- (e) ポップアップのブロック ----
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'text/html; charset=utf-8'); res.end('<!doctype html><title>opener</title><body>opener</body>'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await ev(`chrome.storage.local.set({ customFilters: '||popup-ad.test^$popup' })`);
  await sleep(1500);
  const { targetId: openerTarget } = await b.send('Target.createTarget', { url: `http://127.0.0.1:${port}/` });
  const { sessionId: opener } = await b.send('Target.attachToTarget', { targetId: openerTarget, flatten: true });
  await sleep(2000);
  const evOpener = evIn(opener);
  await evOpener(`(window.__w = { ad: window.open('http://popup-ad.test/ad', '_blank'), ok: window.open('http://ok-site.test/', '_blank') }, true)`);
  await sleep(5000);
  const closed = await evOpener('({ ad: window.__w.ad ? window.__w.ad.closed : null, ok: window.__w.ok ? window.__w.ok.closed : null })');
  console.log(`  ポップアップ: ${JSON.stringify(closed)}`);
  check('(e) $popup に当たるポップアップ（popup-ad.test）が閉じられる', closed.ad === true);
  check('(e) 当たらないポップアップ（ok-site.test）は閉じられない', closed.ok === false);
  await ev(`chrome.storage.local.remove('customFilters')`);
  await b.send('Target.closeTarget', { targetId: openerTarget }).catch(() => {});
  server.close();
  const popupsJson = await ev(`fetch(chrome.runtime.getURL('rules/popups.json')).then(r => r.json()).then(j => Object.keys(j.lists).length)`);
  check('rules/popups.json（$popup のデータ）が読める', popupsJson > 0, `${popupsJson} リスト分`);

  // ---- 最後に、service worker の実行時のエラーをもう一度 ----
  const final = await readInfo();
  check('(d) 一連の操作のあとも、実行時のエラーがない', final.runtimeErrors.length === 0, final.runtimeErrors.map((e) => e.message).join(' | '));
} finally {
  await b.close();
}

const ng = results.filter((r) => !r.ok);
fs.writeFileSync(path.join(outDir, 'package-check.json'), JSON.stringify({ extSrc, browser: browserName, info, results }, null, 2));
console.log(`\n${results.length - ng.length}/${results.length} 件 OK。${ng.length ? `NG: ${ng.map((r) => r.name).join(' / ')}` : ''}`);
console.log('出力:', outDir);
process.exitCode = ng.length ? 1 : 0;
