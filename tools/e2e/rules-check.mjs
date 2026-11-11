// 規則の読み込みの自己点検。拡張機能を入れた Chrome を起動し、その service worker の中から
// declarativeNetRequest を調べて、Chrome が無視した静的ルールがないかを確かめる。
// 使い方: node tools/e2e/rules-check.mjs [--out <dir>]
//  1) 有効なルールセットと、コピーした rules/*.json の件数を比べる(ルールセットを 1 つずつ有効化して実際の件数を数える)
//  2) regexFilter が Chrome で使えるか(isRegexSupported)を全部調べる
//  3) testMatchOutcome で、代表的な URL にルールが実際に効くかを確かめる
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep } from './lib/browser.mjs';
import { Manager } from './lib/manager.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_SRC = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = path.resolve(opt('out', path.join(HERE, 'out', stamp + '_rules')));
fs.mkdirSync(outDir, { recursive: true });

// --ext <dir> で読み込む拡張機能を指定できる(既定はリポジトリのルート。公開版は dist/package)
const mgr = new Manager({ mode: 'adban', extSrc: path.resolve(opt('ext', EXT_SRC)), log: console.log });
const b = await mgr.get();
const extDir = b.extCopy;

// 拡張機能の service worker に繋ぐ。見つからなければ拡張機能のページ(options)で代用する
async function attach() {
  const { targetInfos } = await b.send('Target.getTargets');
  const sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${b.extId}/`));
  if (sw) {
    const { sessionId } = await b.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
    return { sessionId, where: 'service worker' };
  }
  const { targetId } = await b.send('Target.createTarget', { url: `chrome-extension://${b.extId}/options/options.html` });
  const { sessionId } = await b.send('Target.attachToTarget', { targetId, flatten: true });
  await sleep(1500);
  return { sessionId, where: '拡張機能の options ページ(service worker が停止していたため代用)' };
}
const { sessionId, where } = await attach();
console.log('評価場所:', where);
async function ev(expr) {
  const r = await b.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
}

const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
const declared = manifest.declarative_net_request?.rule_resources || [];
const files = {};
for (const rr of declared) {
  const rules = JSON.parse(fs.readFileSync(path.join(extDir, rr.path), 'utf8'));
  files[rr.id] = { path: rr.path, enabledInManifest: rr.enabled, count: rules.length, rules };
}
const fileTotal = Object.values(files).reduce((t, f) => t + f.count, 0);

const result = { where, extId: b.extId, version: manifest.version };
result.enabledRulesets = await ev('chrome.declarativeNetRequest.getEnabledRulesets()');
result.constants = await ev(`(() => { const d = chrome.declarativeNetRequest; return { MAX_NUMBER_OF_STATIC_RULES: d.MAX_NUMBER_OF_STATIC_RULES, GUARANTEED_MINIMUM_STATIC_RULES: d.GUARANTEED_MINIMUM_STATIC_RULES, MAX_NUMBER_OF_ENABLED_STATIC_RULESETS: d.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS, MAX_NUMBER_OF_REGEX_RULES: d.MAX_NUMBER_OF_REGEX_RULES, MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES: d.MAX_NUMBER_OF_UNSAFE_DYNAMIC_RULES }; })()`);
result.availableAll = await ev('chrome.declarativeNetRequest.getAvailableStaticRuleCount()');
// MAX_NUMBER_OF_STATIC_RULES は新しい Chrome では未定義。全体の上限 300000 + 保証分(GUARANTEED_MINIMUM_STATIC_RULES)で代用する
result.maxStaticUsed = result.constants.MAX_NUMBER_OF_STATIC_RULES ?? (300000 + (result.constants.GUARANTEED_MINIMUM_STATIC_RULES ?? 0));
result.loadedByConstant = result.maxStaticUsed - result.availableAll;
result.dynamicRules = (await ev('chrome.declarativeNetRequest.getDynamicRules()')).length;
result.sessionRules = (await ev('chrome.declarativeNetRequest.getSessionRules()')).length;
result.fileTotal = fileTotal;

// ルールセットを 1 つずつ有効化して、実際に読み込まれた件数を数える
const ids = declared.map((r) => r.id);
await ev(`chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: ${JSON.stringify(ids)} })`);
const avail0 = await ev('chrome.declarativeNetRequest.getAvailableStaticRuleCount()');
const per = [];
for (const id of ids) {
  let loaded = null, err = null;
  try {
    await ev(`chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: [${JSON.stringify(id)}] })`);
    loaded = avail0 - (await ev('chrome.declarativeNetRequest.getAvailableStaticRuleCount()'));
    await ev(`chrome.declarativeNetRequest.updateEnabledRulesets({ disableRulesetIds: [${JSON.stringify(id)}] })`);
  } catch (e) { err = e.message; }
  const disabledIds = await ev(`chrome.declarativeNetRequest.getDisabledRuleIds({ rulesetId: ${JSON.stringify(id)} })`).catch(() => []);
  per.push({ id, file: files[id].count, loaded, diff: loaded == null ? null : files[id].count - loaded, error: err, disabledRuleIds: disabledIds.length });
}
// 元に戻す(全部有効)
await ev(`chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: ${JSON.stringify(ids)} })`);
result.availableRestored = await ev('chrome.declarativeNetRequest.getAvailableStaticRuleCount()');
result.perRuleset = per;

// regexFilter が Chrome で使えるか
const regexRules = [];
for (const [id, f] of Object.entries(files)) for (const r of f.rules) if (r.condition?.regexFilter) regexRules.push({ ruleset: id, id: r.id, regex: r.condition.regexFilter, cs: !!r.condition.isUrlFilterCaseSensitive, cap: !!r.action?.redirect?.regexSubstitution });
const unsupported = [];
for (const r of regexRules) {
  const ok = await ev(`chrome.declarativeNetRequest.isRegexSupported({ regex: ${JSON.stringify(r.regex)}, isCaseSensitive: ${r.cs}, requireCapturing: ${r.cap} })`);
  if (!ok.isSupported) unsupported.push({ ...r, reason: ok.reason });
}
result.regex = { total: regexRules.length, unsupported };

// redirect 先の extensionPath が実在するか
const missing = [];
for (const [id, f] of Object.entries(files)) {
  for (const r of f.rules) {
    const ep = r.action?.redirect?.extensionPath;
    if (ep && !fs.existsSync(path.join(extDir, ep.replace(/^\//, '')))) missing.push({ ruleset: id, id: r.id, extensionPath: ep });
  }
}
result.missingRedirectTargets = missing;

// testMatchOutcome
const findRule = (pred) => { for (const [id, f] of Object.entries(files)) { const r = f.rules.find(pred); if (r) return { ruleset: id, rule: r }; } return null; };
const docRule = findRule((r) => r.action.type === 'block' && (r.condition.resourceTypes || []).includes('main_frame') && r.condition.urlFilter);
const cspRule = findRule((r) => r.action.type === 'modifyHeaders' && JSON.stringify(r.action).toLowerCase().includes('content-security-policy'));
const urlFromFilter = (f) => 'https://' + f.replace(/^\|\|/, '').replace(/[\^*|].*$/, '').replace(/\/$/, '') + '/';
// $csp(modifyHeaders)の testMatchOutcome の呼び方(csp-check.mjs で実機確認済み):
//  - requestDomains のルール … main_frame、initiator なし、URL は対象ドメイン
//  - initiatorDomains のルール … sub_frame、initiator も URL も対象ドメイン(ページを直接開く main_frame には initiator が無いので当たらない)
//  - urlFilter だけのルール(||name.*^ や ||host^)… 対象ホストの URL
function cspRequest(r) {
  const c = r.condition;
  const types = c.resourceTypes || ['main_frame', 'sub_frame'];
  const wild = /^\|\|([a-z0-9-]+)\.\*\^$/i.exec(c.urlFilter || '');
  const host = (c.requestDomains || c.initiatorDomains || [])[0] || (wild ? wild[1] + '.com' : (c.urlFilter || '').replace(/^\|\|/, '').replace(/[\^*|/].*$/, ''));
  if (!host) return { skip: 'ホストを組み立てられない条件' };
  if (c.initiatorDomains) return { url: `https://${host}/x`, initiator: `https://${host}`, type: 'sub_frame' };
  return { url: `https://${host}/`, initiator: undefined, type: types.includes('main_frame') ? 'main_frame' : 'sub_frame' };
}

const tests = [
  { name: 'Prime Video GetPlaybackResources(deviceAdInsertionTypeOverride を外す)', url: 'https://atv-ps-fe.amazon.co.jp/cdp/catalog/GetPlaybackResources?asin=B0TEST&deviceAdInsertionTypeOverride=SSAI&deviceID=x', initiator: 'https://www.amazon.co.jp', type: 'xmlhttprequest', expect: 'redirect' },
  { name: 'Prime Video GetPlaybackResources(%2CCuepointPlaylist を外す)', url: 'https://atv-ps-fe.amazon.co.jp/cdp/catalog/GetPlaybackResources?resources=PlaybackUrls%2CCuepointPlaylist%2CAdPods&asin=B0TEST', initiator: 'https://www.amazon.co.jp', type: 'xmlhttprequest', expect: 'redirect' },
  { name: '広告スクリプト: securepubads.g.doubleclick.net/tag/js/gpt.js(偽物に差し替え)', url: 'https://securepubads.g.doubleclick.net/tag/js/gpt.js', initiator: 'https://example.com', type: 'script', expect: 'redirect' },
  { name: '広告スクリプト: pagead2.googlesyndication.com adsbygoogle.js(偽物に差し替え)', url: 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js', initiator: 'https://example.com', type: 'script', expect: 'redirect' },
  { name: '計測: www.google-analytics.com/analytics.js(偽物に差し替え)', url: 'https://www.google-analytics.com/analytics.js', initiator: 'https://example.com', type: 'script', expect: 'redirect' },
  { name: '計測: www.googletagmanager.com/gtag/js(偽物に差し替え)', url: 'https://www.googletagmanager.com/gtag/js?id=G-TEST', initiator: 'https://example.com', type: 'script', expect: 'redirect' },
  { name: '広告のフレーム: googleads.g.doubleclick.net', url: 'https://googleads.g.doubleclick.net/pagead/ads?client=ca-pub-1', initiator: 'https://example.com', type: 'sub_frame', expect: 'block' },
  { name: '広告の画像: ad.doubleclick.net', url: 'https://ad.doubleclick.net/ddm/trackimp/x', initiator: 'https://example.com', type: 'image', expect: 'block' },
  { name: '日本の広告: yads.c.yimg.jp/js/yads-async.js', url: 'https://yads.c.yimg.jp/js/yads-async.js', initiator: 'https://news.yahoo.co.jp', type: 'script', expect: 'any' },
  { name: '日本の広告: i-mobile(spad.i-mobile.co.jp)', url: 'https://spad.i-mobile.co.jp/script/adv.js', initiator: 'https://example.jp', type: 'script', expect: 'block' },
  { name: 'Facebook Pixel: connect.facebook.net/en_US/fbevents.js', url: 'https://connect.facebook.net/en_US/fbevents.js', initiator: 'https://example.com', type: 'script', expect: 'block' },
  { name: '対照: 広告と無関係(example.com の script)', url: 'https://example.com/app.js', initiator: 'https://example.com', type: 'script', expect: 'none' },
];
if (docRule) tests.push({ name: `$document のブロック(${docRule.ruleset} #${docRule.rule.id}: ${docRule.rule.condition.urlFilter})`, url: urlFromFilter(docRule.rule.condition.urlFilter), initiator: undefined, type: 'main_frame', expect: 'block' });
else tests.push({ name: '$document のブロック', skip: 'この版の rules/ には main_frame を対象にした block ルールが無い' });
if (cspRule) tests.push({ name: `$csp(代表: ${cspRule.ruleset} #${cspRule.rule.id})`, ...cspRequest(cspRule.rule), expect: 'modifyHeaders' });
else tests.push({ name: '$csp(modifyHeaders)', skip: 'この版の rules/ には Content-Security-Policy を付けるルールが無い' });

const ruleInfo = (rsId, ruleId) => { const r = files[rsId]?.rules.find((x) => x.id === ruleId); if (!r) return '?'; const a = r.action; return a.type + (a.type === 'allow' ? ` (${r.condition.urlFilter || r.condition.regexFilter || ''} ${(r.condition.initiatorDomains || r.condition.requestDomains || []).slice(0, 3).join(',')})` : '') + (a.redirect?.extensionPath ? ' -> ' + a.redirect.extensionPath : a.redirect?.transform ? ' (transform)' : a.redirect?.regexSubstitution ? ' (regexSubstitution)' : ''); };
result.matchTests = [];
for (const t of tests) {
  if (t.skip) { result.matchTests.push({ name: t.name, skip: t.skip }); continue; }
  const req = { url: t.url, type: t.type };
  if (t.initiator) req.initiator = t.initiator;
  try {
    const r = await ev(`chrome.declarativeNetRequest.testMatchOutcome(${JSON.stringify(req)})`);
    const matched = (r.matchedRules || []).map((m) => ({ ruleset: m.rulesetId, id: m.ruleId, action: ruleInfo(m.rulesetId, m.ruleId) }));
    const kinds = matched.map((m) => m.action.split(' ')[0]);
    const ok = t.expect === 'any' ? true : t.expect === 'none' ? matched.length === 0 : kinds.includes(t.expect);
    result.matchTests.push({ name: t.name, url: t.url, type: t.type, initiator: t.initiator || null, expect: t.expect, matched, ok });
  } catch (e) { result.matchTests.push({ name: t.name, url: t.url, error: e.message, ok: false }); }
}

// 全ての $csp(modifyHeaders)ルールを、上の呼び方で testMatchOutcome にかける
{
  const all = [];
  for (const [rsId, f] of Object.entries(files)) for (const r of f.rules) if (r.action.type === 'modifyHeaders' && JSON.stringify(r.action).toLowerCase().includes('content-security-policy')) all.push({ rsId, r });
  const rows = [];
  for (const { rsId, r } of all) {
    const q = cspRequest(r);
    if (q.skip) { rows.push({ rule: `${rsId}#${r.id}`, skip: q.skip }); continue; }
    const req = { url: q.url, type: q.type };
    if (q.initiator) req.initiator = q.initiator;
    const m = await ev(`chrome.declarativeNetRequest.testMatchOutcome(${JSON.stringify(req)})`).then((x) => (x.matchedRules || []).map((y) => `${y.rulesetId}#${y.ruleId}`)).catch(() => []);
    rows.push({ rule: `${rsId}#${r.id}`, kind: r.condition.initiatorDomains ? 'initiatorDomains' : r.condition.requestDomains ? 'requestDomains' : 'urlFilter', req, ok: m.includes(`${rsId}#${r.id}`), matched: m });
  }
  result.cspAll = { total: all.length, ok: rows.filter((x) => x.ok).length, rows };
}

// turtlecute で「止められていない」と出た項目について、実際にルールが当たるかを testMatchOutcome で確かめる(--turtlecute <計測結果の out ディレクトリ>)
result.turtlecute = null;
const tcDir = opt('turtlecute', null);
if (tcDir) {
  const rep = JSON.parse(fs.readFileSync(path.join(path.resolve(tcDir), 'report.json'), 'utf8'));
  const det = (rep.detectors || []).find((d) => d.name.includes('turtlecute'));
  const open_ = (det?.adban?.items || []).filter((i) => /not blocked/i.test(i.status) && !/^Cosmetic/i.test(i.group));
  const rows = [];
  for (const it of open_) {
    const isHost = /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(it.name) && !/\.js$/i.test(it.name);
    if (!isHost) { rows.push({ group: it.group, name: it.name, note: 'ホスト名ではなくファイル名のテスト(サイト限定のルールが必要)' }); continue; }
    let found = null;
    for (const type of ['xmlhttprequest', 'image', 'script']) {
      const r = await ev(`chrome.declarativeNetRequest.testMatchOutcome(${JSON.stringify({ url: 'https://' + it.name + '/', initiator: 'https://adblock.turtlecute.org', type })})`).catch(() => ({ matchedRules: [] }));
      const m = (r.matchedRules || []).map((x) => ({ ruleset: x.rulesetId, id: x.ruleId, action: ruleInfo(x.rulesetId, x.ruleId) }));
      if (m.length) { found = { type, matched: m }; break; }
    }
    rows.push({ group: it.group, name: it.name, ...(found || { matched: [] }) });
  }
  result.turtlecute = rows;
}

await mgr.close();

// ---- 出力 ----
const L = [];
L.push('# 規則の読み込みの自己点検', '');
L.push(`- 拡張機能 v${result.version}(評価場所: ${where})`);
L.push(`- 有効なルールセット: ${result.enabledRulesets.join(', ')}`);
L.push(`- 定数: ${JSON.stringify(result.constants)}`);
L.push(`- 静的ルール: rules/*.json の合計 ${fileTotal} 件。全部有効のときの getAvailableStaticRuleCount = ${result.availableAll}(上限 ${result.maxStaticUsed} - available = 読み込まれた静的ルール ${result.loadedByConstant} 件)`);
L.push(`- 動的ルール ${result.dynamicRules} 件、セッションルール ${result.sessionRules} 件`, '');
L.push('## ルールセットごとの件数(1 つずつ有効化して数えた)', '');
L.push('| ルールセット | ファイルの件数 | 実際に読み込まれた件数 | 差 | 無効化されたルール ID | 備考 |', '|---|---:|---:|---:|---:|---|');
for (const p of per) L.push(`| ${p.id} | ${p.file} | ${p.loaded ?? '-'} | ${p.diff ?? '-'} | ${p.disabledRuleIds} | ${p.error || (p.diff === 0 ? '一致' : '**差あり(Chrome が無視したルールがある)**')} |`);
const sumLoaded = per.reduce((t, p) => t + (p.loaded || 0), 0);
L.push(`| 合計 | ${fileTotal} | ${sumLoaded} | ${fileTotal - sumLoaded} | | |`, '');
L.push(`## 正規表現(regexFilter)`, '', `- ${result.regex.total} 件中、Chrome が使えないもの: ${result.regex.unsupported.length} 件`);
for (const u of result.regex.unsupported) L.push(`  - ${u.ruleset} #${u.id}: \`${u.regex}\` (${u.reason})`);
L.push('', '## redirect 先(extensionPath)が存在しないルール', '', missing.length ? missing.map((m) => `- ${m.ruleset} #${m.id}: ${m.extensionPath}`).join('\n') : '- なし', '');
L.push('## testMatchOutcome(代表的なルールが実際に効くか)', '');
L.push('| 確認内容 | type | 期待 | 結果 | 一致したルール |', '|---|---|---|---|---|');
for (const t of result.matchTests) {
  if (t.skip) { L.push(`| ${t.name} | - | - | 未確認 | ${t.skip} |`); continue; }
  L.push(`| ${t.name} | ${t.type || '-'} | ${t.expect || '-'} | ${t.error ? 'エラー: ' + t.error : t.ok ? 'OK' : '**NG(効いていない)**'} | ${(t.matched || []).map((m) => `${m.ruleset} #${m.id} ${m.action}`).join('<br>') || '(一致なし)'} |`);
}
L.push('');
if (result.cspAll) {
  const c = result.cspAll;
  L.push('## $csp(modifyHeaders)ルールの全件確認', '');
  L.push(`- ${c.total} 件中 ${c.ok} 件が testMatchOutcome で当たった(呼び方: requestDomains・urlFilter は main_frame・initiator なし、initiatorDomains は sub_frame・同ドメイン initiator)。`);
  const ng = c.rows.filter((x) => !x.ok);
  const kinds = {};
  for (const x of c.rows) kinds[x.kind || 'skip'] = (kinds[x.kind || 'skip'] || 0) + 1;
  L.push(`- 条件の種類: ${JSON.stringify(kinds)}`);
  if (ng.length) { L.push('- 当たらなかったルール:'); for (const x of ng) L.push(`  - ${x.rule} ${x.skip ? '(' + x.skip + ')' : JSON.stringify(x.req)} 一致: ${(x.matched || []).join(',') || 'なし'}`); }
  L.push('');
}
if (result.turtlecute) {
  L.push('## turtlecute で止められていない項目に、ルールは当たるか(testMatchOutcome)', '');
  L.push('| グループ | 項目 | 当たったルール | 推測 |', '|---|---|---|---|');
  for (const r of result.turtlecute) {
    const acts = (r.matched || []).map((m) => `${m.ruleset} #${m.id} ${m.action}`).join('<br>');
    const kind = r.note ? r.note : !r.matched?.length ? 'どのルールにも当たらない(ホストがルール化されていない)' : r.matched.some((m) => m.action.startsWith('allow')) ? 'allow(例外)ルールで除外されている' : r.matched.some((m) => m.action.startsWith('redirect')) ? '差し替え(偽物を返すので「止められた」と数えられない)' : 'block ルールに当たる(type 違いなどで実際の通信は通った可能性)';
    L.push(`| ${r.group} | ${r.name} | ${acts || '(なし)'}${r.type ? ' (type=' + r.type + ')' : ''} | ${kind} |`);
  }
  L.push('');
}
fs.writeFileSync(path.join(outDir, 'rules-check.md'), L.join('\n'));
fs.writeFileSync(path.join(outDir, 'rules-check.json'), JSON.stringify(result, null, 2));
console.log(L.join('\n'));
console.log('出力:', outDir);
