// $csp(declarativeNetRequest の modifyHeaders で Content-Security-Policy を足すルール)が実機で効くかの確認。
// 使い方: node tools/e2e/csp-check.mjs [--out <dir>]
//  1) rules/ の modifyHeaders ルールを testMatchOutcome にかける(type / initiator / URL の組み合わせを変えて、当たる条件を調べる)
//  2) 動的ルール: customFilters に $csp を入れ(background.js が動的ルールにする)、127.0.0.1 の簡単なサーバーのページで
//     main_frame / sub_frame の両方に CSP が付くか(インライン script が止まるか)を確かめる
//  3) 静的ルール: --host-resolver-rules でルールの対象ドメイン(filecrypt.cc など)を 127.0.0.1 に向け、本物の静的ルールが
//     main_frame / sub_frame の応答に効くか(CSP 違反が起きるか)を確かめる
//  4) 修正案(initiatorDomains を requestDomains にしたルール)を一時的に動的ルールとして入れて、効くことを確かめる
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_SRC = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outDir = path.resolve(opt('out', path.join(HERE, 'out', stamp + '_csp')));
fs.mkdirSync(outDir, { recursive: true });

// ---- 現物の rules/ から modifyHeaders(CSP)のルールを集める ----
const ruleFiles = fs.readdirSync(path.join(EXT_SRC, 'rules')).filter((f) => /^[a-z]+\.json$/.test(f) && f !== 'meta.json');
const cspRules = [];
for (const f of ruleFiles) {
  const rules = JSON.parse(fs.readFileSync(path.join(EXT_SRC, 'rules', f), 'utf8'));
  if (!Array.isArray(rules)) continue; // ルールの配列でないファイル(メタ情報など)は飛ばす
  for (const r of rules) {
    if (r.action.type === 'modifyHeaders' && (r.action.responseHeaders || []).some((h) => /content-security-policy/i.test(h.header))) {
      cspRules.push({ ruleset: f.replace(/\.json$/, ''), rule: r });
    }
  }
}
console.log(`CSP の modifyHeaders ルール: ${cspRules.length} 件(${ruleFiles.join(', ')} の現物)`);
// 対象ホスト。||name.*^ のような TLD ワイルドカードは name.test に置き換えて試す
const wildHost = (r) => { const m = /^\|\|([a-z0-9-]+)\.\*\^$/i.exec(r.condition.urlFilter || ''); return m ? [m[1] + '.test'] : null; };
const domainsOf = (r) => r.condition.initiatorDomains || r.condition.requestDomains || wildHost(r) || [];
const onlyIds = (opt('only-ids', '') || '').split(',').filter(Boolean);
const skipDynamic = argv.includes('--skip-dynamic');
const hostsToMap = new Set(['ext.csp.test', 'nomatch.test', 'scoped.test']);
for (const { rule } of cspRules) for (const d of domainsOf(rule)) hostsToMap.add(d);

// ---- Chrome に host-resolver-rules を足す(lib/browser.mjs は編集せず、spawn を包む) ----
const mapRules = [...hostsToMap].map((h) => `MAP ${h} 127.0.0.1`).join(',') + ',MAP *.localhost 127.0.0.1';
const origSpawn = cp.spawn;
cp.spawn = (exe, args, o) => origSpawn(exe, [...args, `--host-resolver-rules=${mapRules}`], o);
syncBuiltinESMExports();
const { sleep } = await import('./lib/browser.mjs');
const { Manager } = await import('./lib/manager.mjs');
const { Page } = await import('./lib/measure.mjs');

// ---- テスト用サーバー(CSP ヘッダーなしで HTML を返す) ----
const PROBE = `(function(){var v=[];document.addEventListener('securitypolicyviolation',function(e){v.push(e.violatedDirective)});
var s=document.createElement('script');s.src='http://ext.csp.test:__PORT__/ext.js';document.head.appendChild(s);
var w='';try{new Worker(URL.createObjectURL(new Blob(['1'],{type:'text/javascript'})));w='ok'}catch(e){w='err'}
document.title='inline-ran';
setTimeout(function(){var r={ran:true,v:v,ext:!!window.__ext,worker:w,host:location.host};window.__res=r;try{parent.postMessage(r,'*')}catch(e){}},1500)})();`;
let PORT = 0;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const host = (req.headers.host || '').split(':')[0];
  res.setHeader('cache-control', 'no-store');
  if (u.pathname === '/ext.js') { res.setHeader('content-type', 'text/javascript'); res.end('window.__ext=true;'); return; }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  if (u.pathname === '/parent') {
    res.end(`<!doctype html><title>parent</title><script>window.__msgs=[];window.__loaded=false;addEventListener('message',function(e){window.__msgs.push(e.data)})</script>
<iframe src="${u.searchParams.get('frame')}" onload="window.__loaded=true" width="300" height="100"></iframe>`);
    return;
  }
  res.end(`<!doctype html><title>noscript</title><body>${host}<script>${PROBE.replace(/__PORT__/g, PORT)}</script></body>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
PORT = server.address().port;
const url = (host, p = '/') => `http://${host}:${PORT}${p}`;

// ---- ブラウザ起動、拡張機能の service worker に繋ぐ ----
// 本体を別の担当が編集中で、manifest が存在しないルールファイルを指していることがある。その場合は、
// 存在しないルールセットだけを外した manifest のコピーで試す(CSP の検証には無関係なため)
let extSrc = EXT_SRC;
{
  const man = JSON.parse(fs.readFileSync(path.join(EXT_SRC, 'manifest.json'), 'utf8'));
  const missing = (man.declarative_net_request?.rule_resources || []).filter((r) => !fs.existsSync(path.join(EXT_SRC, r.path)));
  if (missing.length) {
    const os = await import('node:os');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'adban-e2e-cspsrc-'));
    fs.cpSync(EXT_SRC, tmp, { recursive: true, filter: (s2) => !['tools', 'node_modules', '.git', '_metadata'].includes(path.relative(EXT_SRC, s2).split(path.sep)[0]) });
    man.declarative_net_request.rule_resources = man.declarative_net_request.rule_resources.filter((r) => !missing.includes(r));
    fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(man, null, 2));
    extSrc = tmp;
    console.log('注意: 存在しないルールセットを外して試します:', missing.map((m) => m.id).join(', '));
  }
}
const mgr = new Manager({ mode: 'adban', extSrc, log: console.log });
const b = await mgr.get();
async function attach() {
  const { targetInfos } = await b.send('Target.getTargets');
  const sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${b.extId}/`));
  if (sw) return (await b.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true })).sessionId;
  const { targetId } = await b.send('Target.createTarget', { url: `chrome-extension://${b.extId}/options/options.html` });
  const { sessionId } = await b.send('Target.attachToTarget', { targetId, flatten: true });
  await sleep(1500);
  return sessionId;
}
const sw = await attach();
async function ev(expr) {
  const r = await b.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sw);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
}
const J = JSON.stringify;
const tmo = (req) => ev(`chrome.declarativeNetRequest.testMatchOutcome(${J(req)})`).then((r) => (r.matchedRules || []).map((m) => `${m.rulesetId}#${m.ruleId}`));

const result = { cspRules: cspRules.map((c) => ({ ruleset: c.ruleset, id: c.rule.id, condition: c.rule.condition })), match: [], dynamic: [], static: [], fix: [] };

// ---- 1) testMatchOutcome の条件を変えて、当たる条件を調べる ----
for (const { ruleset, rule } of cspRules) {
  const d = domainsOf(rule)[0];
  const variants = [
    { name: 'main_frame / initiator なし(ブラウザからの移動)', req: { url: `https://${d}/`, type: 'main_frame' } },
    { name: 'main_frame / initiator = 同じドメイン', req: { url: `https://${d}/`, type: 'main_frame', initiator: `https://${d}` } },
    { name: 'sub_frame / initiator = 同じドメイン(同一サイトの iframe)', req: { url: `https://${d}/frame`, type: 'sub_frame', initiator: `https://${d}` } },
    { name: 'sub_frame / initiator = www.同じドメイン', req: { url: `https://www.${d}/frame`, type: 'sub_frame', initiator: `https://www.${d}` } },
    { name: 'sub_frame / initiator なし', req: { url: `https://${d}/frame`, type: 'sub_frame' } },
    { name: 'sub_frame / initiator = 別サイト(第三者)', req: { url: `https://${d}/frame`, type: 'sub_frame', initiator: 'https://other.example' } },
    { name: 'sub_frame / initiator = 別サイト、URL は別ドメイン', req: { url: 'https://other.example/frame', type: 'sub_frame', initiator: `https://${d}` } },
  ];
  for (const v of variants) {
    const m = await tmo(v.req).catch((e) => ['エラー: ' + e.message]);
    result.match.push({ rule: `${ruleset}#${rule.id}`, case: v.name, req: v.req, matched: m, hit: m.includes(`${ruleset}#${rule.id}`) });
  }
}

// ---- 実機のページ計測 ----
async function probe(pageUrl, { frame = false, wait = 2800, parentHost = '127.0.0.1' } = {}) {
  const page = new Page(b);
  const headers = [];
  const off = b.on(undefined, null, (p, sid, m) => {
    if (!page.sessions.has(sid)) return;
    if (m === 'Network.responseReceived' && /^(Document)$/.test(p.type)) headers.push({ via: 'responseReceived', url: p.response.url, csp: p.response.headers['content-security-policy'] || p.response.headers['Content-Security-Policy'] || null });
    if (m === 'Network.responseReceivedExtraInfo') {
      const h = Object.entries(p.headers || {}).find(([k]) => k.toLowerCase() === 'content-security-policy');
      if (h) headers.push({ via: 'responseReceivedExtraInfo', csp: h[1] });
    }
  });
  let out = null, err = null;
  try {
    await page.open();
    await page.navigate(frame ? url(parentHost, '/parent?frame=' + encodeURIComponent(pageUrl)) : pageUrl, 15000);
    await sleep(wait);
    out = frame
      ? await page.eval('JSON.stringify({loaded: window.__loaded, msgs: window.__msgs})')
      : await page.eval('JSON.stringify({title: document.title, res: window.__res || null})');
    out = JSON.parse(out);
  } catch (e) { err = e.message; }
  off();
  await page.close();
  return { out, headers, err };
}
// 結果を「CSP が効いたか」に要約する
function verdict(r, kind) {
  if (r.err) return { applied: null, note: 'エラー: ' + r.err };
  const hv = (r.headers || []).find((h) => h.csp && h.via === 'responseReceived');
  if (hv) {
    // 応答ヘッダーに付いた CSP(DNR が足したもの)が見えた。これが一番確かな証拠
    const o2 = r.out; const res2 = kind === 'frame' ? (o2?.msgs || [])[0] : o2?.res;
    return { applied: true, header: hv.csp, note: `応答に CSP が付いた: ${String(hv.csp).slice(0, 70)}` + (res2 ? ` / 違反: ${(res2.v || []).join(',') || 'なし'}` : ' / インライン script は実行されなかった'), raw: r.out };
  }
  const o = r.out;
  const res = kind === 'frame' ? (o.msgs || [])[0] : o.res;
  if (kind === 'frame') {
    if (!o.msgs || !o.msgs.length) return { applied: true, note: 'iframe 内のインライン script が実行されなかった(script-src に阻まれた可能性)', raw: o };
  } else if (!o.res) return { applied: true, note: 'インライン script が実行されなかった(タイトルは ' + o.title + ')', raw: o };
  const viol = res.v || [];
  return { applied: viol.length > 0 || !res.ext, note: `inline 実行 / 外部 script ${res.ext ? '実行された' : '実行されなかった'} / worker ${res.worker} / 違反: ${viol.join(',') || 'なし'}`, raw: res };
}

// ---- 2) 動的ルール(customFilters) ----
async function setCustom(text) {
  await ev(`chrome.storage.local.set({ customFilters: ${J(text)} })`);
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const n = (await ev('chrome.declarativeNetRequest.getDynamicRules()')).length;
    if ((text.trim() ? n > 0 : n === 0)) break;
  }
  await sleep(800);
  return ev('chrome.declarativeNetRequest.getDynamicRules()');
}
const dynCases = [
  { name: '$csp(ドメイン指定 ||localhost^)', filter: "||localhost^$csp=script-src 'none'", hit: [['csp-test.localhost', 'main'], ['csp-test.localhost', 'frame']], miss: [['127.0.0.1', 'main'], ['nomatch.test', 'main']] },
  { name: '$csp,domain=scoped.test(対象ページを domain= で指定)', filter: "*$csp=script-src 'none',domain=scoped.test", hit: [['scoped.test', 'main'], ['scoped.test', 'frame']], miss: [['nomatch.test', 'main']] },
];
for (const c of (skipDynamic ? [] : dynCases)) {
  const rules = await setCustom(c.filter);
  const compiled = rules.map((r) => ({ id: r.id, action: r.action.type, condition: r.condition }));
  const entry = { case: c.name, filter: c.filter, compiled, runs: [] };
  console.log('動的ルール:', c.filter, '->', J(compiled).slice(0, 300));
  for (const [host, kind] of [...c.hit, ...c.miss]) {
    const isHit = c.hit.some((h) => h[0] === host && h[1] === kind);
    const r = await probe(url(host), { frame: kind === 'frame' });
    const v = verdict(r, kind);
    entry.runs.push({ host, kind, expected: isHit ? '効く' : '効かない(対照)', applied: v.applied, note: v.note, headers: r.headers });
    console.log(`  ${host} ${kind}: 期待=${isHit ? '効く' : '対照'} 結果=${v.applied} ${v.note}`);
  }
  // testMatchOutcome でも同じ条件を確かめる
  if (rules.length) {
    const d = c.hit[0][0];
    entry.testMatch = {
      main_frame_noinitiator: await tmo({ url: url(d), type: 'main_frame' }),
      sub_frame_initiator_same: await tmo({ url: url(d), type: 'sub_frame', initiator: url(d) }),
      sub_frame_initiator_other: await tmo({ url: url(d), type: 'sub_frame', initiator: url('nomatch.test') }),
    };
  }
  result.dynamic.push(entry);
}
await setCustom('');

// ---- 3) 静的ルール(本物の rules/ のルールに当たるホストを 127.0.0.1 に向けて確かめる) ----
for (const { ruleset, rule } of cspRules) {
  if (onlyIds.length && !onlyIds.includes(`${ruleset}#${rule.id}`)) continue;
  const d = domainsOf(rule)[0];
  const entry = { rule: `${ruleset}#${rule.id}`, host: d, condition: rule.condition, runs: [] };
  for (const kind of ['main', 'frame']) {
    // initiatorDomains のルールは「親ページ」のドメインで判定されるので、親も同じホストに置く
    const r = await probe(url(d), { frame: kind === 'frame', parentHost: rule.condition.initiatorDomains ? d : '127.0.0.1' });
    const v = verdict(r, kind);
    entry.runs.push({ kind, applied: v.applied, note: v.note, headers: r.headers });
    console.log(`静的 ${entry.rule} ${d} ${kind}: 結果=${v.applied} ${v.note}`);
  }
  // 対照: 同じ HTML を、ルールに当たらないホストで
  const c = await probe(url('nomatch.test'), { frame: true });
  entry.control = verdict(c, 'frame');
  result.static.push(entry);
}

// ---- 4) 修正案: initiatorDomains の代わりに requestDomains を使ったルール(動的ルールとして一時的に入れて確かめる) ----
for (const { ruleset, rule } of cspRules.slice(0, 1)) {
  const d = domainsOf(rule)[0];
  const fixed = JSON.parse(JSON.stringify(rule));
  delete fixed.condition.initiatorDomains;
  delete fixed.condition.domainType;
  fixed.condition.requestDomains = domainsOf(rule);
  fixed.id = 900001;
  const ids = (await ev('chrome.declarativeNetRequest.getDynamicRules()')).map((r) => r.id);
  await ev(`chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ${J(ids)}, addRules: [${J(fixed)}] })`);
  const entry = { rule: `${ruleset}#${rule.id}(requestDomains 版)`, condition: fixed.condition, runs: [], testMatch: {} };
  entry.testMatch.main_frame_noinitiator = await tmo({ url: `https://${d}/`, type: 'main_frame' });
  entry.testMatch.sub_frame_initiator_same = await tmo({ url: `https://${d}/frame`, type: 'sub_frame', initiator: `https://${d}` });
  entry.testMatch.sub_frame_initiator_other = await tmo({ url: `https://${d}/frame`, type: 'sub_frame', initiator: 'https://other.example' });
  for (const kind of ['main', 'frame']) {
    const r = await probe(url(d), { frame: kind === 'frame' });
    const v = verdict(r, kind);
    entry.runs.push({ kind, applied: v.applied, note: v.note });
    console.log(`修正案 ${entry.rule} ${d} ${kind}: 結果=${v.applied} ${v.note}`);
  }
  result.fix.push(entry);
  await ev(`chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [900001] })`);
}

await mgr.close();
server.close();
fs.writeFileSync(path.join(outDir, 'csp-check.json'), J(result, null, 2));

// ---- 出力(Markdown) ----
const L = ['# $csp(modifyHeaders)の実機確認', ''];
L.push(`- rules/ の現物にある CSP の modifyHeaders ルール: ${cspRules.length} 件(${cspRules.map((c) => c.ruleset + '#' + c.rule.id).join(', ')})`, '');
L.push('## 1. testMatchOutcome の呼び方による違い', '', '| ルール | 呼び方 | 当たった |', '|---|---|---|');
for (const m of result.match) L.push(`| ${m.rule} | ${m.case} | ${m.hit ? '当たる' : '**当たらない**'}${m.matched.length && !m.hit ? '(' + m.matched.join(',') + ')' : ''} |`);
L.push('', '## 2. 動的ルール(customFilters の $csp)', '');
for (const e of result.dynamic) {
  L.push(`### ${e.case}`, '', '- フィルター: `' + e.filter + '`', '- 生成された動的ルール: `' + J(e.compiled) + '`');
  if (e.testMatch) L.push('- testMatchOutcome: ' + J(e.testMatch));
  L.push('', '| ホスト | 種類 | 期待 | CSP が効いたか | 詳細 |', '|---|---|---|---|---|');
  for (const r of e.runs) L.push(`| ${r.host} | ${r.kind === 'main' ? 'main_frame' : 'sub_frame'} | ${r.expected} | ${r.applied} | ${r.note} |`);
  L.push('');
}
L.push('## 3. 静的ルール(本物の rules/ のルール)', '', '| ルール | ホスト | 種類 | CSP が効いたか | 詳細 |', '|---|---|---|---|---|');
for (const e of result.static) {
  for (const r of e.runs) L.push(`| ${e.rule} | ${e.host} | ${r.kind === 'main' ? 'main_frame' : 'sub_frame(同一ドメインの iframe)'} | ${r.applied} | ${r.note} |`);
  L.push(`| (対照) | nomatch.test | sub_frame | ${e.control.applied} | ${e.control.note} |`);
}
L.push('', '## 4. 修正案(requestDomains 版を動的ルールとして試す)', '');
for (const e of result.fix) {
  L.push(`- ${e.rule}: testMatchOutcome ${J(e.testMatch)}`);
  for (const r of e.runs) L.push(`  - ${r.kind}: 効いたか=${r.applied} ${r.note}`);
}
fs.writeFileSync(path.join(outDir, 'csp-check.md'), L.join('\n'));
console.log('\n' + L.join('\n'));
console.log('出力:', outDir);
