// 拡張機能として読み込む前の点検。manifest が指すファイルの有無と、ルールの形をブラウザーと同じ観点で確かめる。
//   node tools/check.mjs                … 開発用のフォルダー（このリポジトリ）を点検する
//   node tools/check.mjs --root <dir>   … 別のフォルダー（tools/make-package.mjs が作った公開用パッケージなど）を点検する。
//                                         tools/build-filters.mjs がないフォルダーは配布用とみなし、manifest・meta.json・rules/ のファイルが
//                                         過不足なく対応していること（外したリストの残りがないこと）も確かめる

import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ALLOW_ID_BASE, SCRIPTLETS, parseProcedural } from '../lib/filters.js';
import { PopupMatcher, patternToRegexSource } from '../lib/popup.js';
import { RESOURCE_FILES } from '../lib/resources.js';

const rootArg = process.argv.indexOf('--root');
const root = rootArg > 0 ? pathToFileURL(resolve(process.argv[rootArg + 1] ?? '.') + sep) : new URL('../', import.meta.url);
const problems = [];
const problem = (message) => problems.push(message);

const readJson = async (path) => JSON.parse(await readFile(new URL(path, root), 'utf8'));
const exists = (path) =>
  stat(new URL(path, root)).then(
    () => true,
    () => false,
  );

const RESOURCE_TYPES = new Set([
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest',
  'ping', 'csp_report', 'media', 'websocket', 'webtransport', 'webbundle', 'other',
]);
const DOMAIN_KEYS = ['requestDomains', 'excludedRequestDomains', 'initiatorDomains', 'excludedInitiatorDomains'];
const CONDITION_KEYS = new Set([
  ...DOMAIN_KEYS, 'urlFilter', 'regexFilter', 'isUrlFilterCaseSensitive', 'domainType', 'resourceTypes', 'excludedResourceTypes',
  'requestMethods', 'excludedRequestMethods',
]);
const METHODS = new Set(['connect', 'delete', 'get', 'head', 'options', 'patch', 'post', 'put', 'other']);
const REDIRECT_PATHS = new Set(RESOURCE_FILES.map((f) => `/resources/${f}`));
// 正規表現ルールの上限（chrome.declarativeNetRequest.MAX_NUMBER_OF_REGEX_RULES）
const MAX_REGEX_RULES = 1000;
// 静的ルールの目安の上限（Chrome が保証するのは 30,000 件）
const MAX_STATIC_RULES = 28000;

function checkRule(rule, where) {
  const at = `${where} id=${rule.id}`;
  if (!Number.isInteger(rule.id) || rule.id < 1) problem(`${at}: id が正の整数ではない`);
  if (!Number.isInteger(rule.priority) || rule.priority < 1) problem(`${at}: priority が不正`);
  const type = rule.action?.type;
  if (!['block', 'allow', 'allowAllRequests', 'redirect', 'modifyHeaders'].includes(type)) problem(`${at}: action.type が不正 (${type})`);
  const isAllow = type === 'allow' || type === 'allowAllRequests';
  if (isAllow && rule.id < ALLOW_ID_BASE) problem(`${at}: 許可ルールの id が ${ALLOW_ID_BASE} 未満`);
  if (!isAllow && rule.id >= ALLOW_ID_BASE) problem(`${at}: ブロックルールの id が ${ALLOW_ID_BASE} 以上`);
  if (type === 'allowAllRequests') {
    // resourceTypes が必須で、main_frame・sub_frame だけ
    const rt = rule.condition?.resourceTypes;
    if (!Array.isArray(rt) || !rt.length || rt.some((t) => t !== 'main_frame' && t !== 'sub_frame')) {
      problem(`${at}: allowAllRequests の resourceTypes が不正`);
    }
  }
  if (type === 'modifyHeaders') {
    const h = rule.action.responseHeaders;
    if (rule.action.requestHeaders !== undefined) problem(`${at}: modifyHeaders に requestHeaders`);
    if (!Array.isArray(h) || !h.length) problem(`${at}: modifyHeaders に responseHeaders がない`);
    else {
      for (const x of h) {
        if (!x || x.header !== 'content-security-policy' || x.operation !== 'append') problem(`${at}: responseHeaders が想定外`);
        else if (typeof x.value !== 'string' || !x.value || /[^ -~]/.test(x.value)) problem(`${at}: ヘッダーの値が不正`);
      }
    }
  }
  if (type === 'redirect') {
    const r = rule.action.redirect ?? {};
    const params = r.transform?.queryTransform?.removeParams;
    if (params !== undefined) {
      if (!Array.isArray(params) || !params.length || params.some((n) => typeof n !== 'string' || !n)) {
        problem(`${at}: removeParams が不正`);
      }
    } else if (r.regexSubstitution !== undefined) {
      if (typeof r.regexSubstitution !== 'string' || !r.regexSubstitution) problem(`${at}: regexSubstitution が空`);
      else if (!rule.condition?.regexFilter) problem(`${at}: regexFilter なしで regexSubstitution`);
    } else if (!REDIRECT_PATHS.has(r.extensionPath)) {
      problem(`${at}: 差し替え先のファイルがない (${r.extensionPath})`);
    }
  }

  const c = rule.condition ?? {};
  for (const key of Object.keys(c)) if (!CONDITION_KEYS.has(key)) problem(`${at}: 知らない条件 ${key}`);
  if ('urlFilter' in c && 'regexFilter' in c) problem(`${at}: urlFilter と regexFilter が両方ある`);
  if ('regexFilter' in c) {
    const f = c.regexFilter;
    if (typeof f !== 'string' || !f) problem(`${at}: regexFilter が空`);
    else if (/[^\x20-\x7e]/.test(f)) problem(`${at}: regexFilter に ASCII 以外の文字`);
    else if (/\(\?(?:=|!|<=|<!)/.test(f)) problem(`${at}: regexFilter に先読み・後読み`);
  } else if ('urlFilter' in c) {
    const f = c.urlFilter;
    if (typeof f !== 'string' || !f) problem(`${at}: urlFilter が空`);
    else if (/[^\x21-\x7e]/.test(f)) problem(`${at}: urlFilter に ASCII 以外の文字`);
    else if (f.startsWith('||*')) problem(`${at}: urlFilter が ||* で始まる`);
    else if (f.replace(/^\|\|?/, '').replace(/\|$/, '').includes('|')) problem(`${at}: urlFilter の途中に |`);
  } else if ('isUrlFilterCaseSensitive' in c) {
    problem(`${at}: urlFilter なしで isUrlFilterCaseSensitive`);
  }
  for (const key of DOMAIN_KEYS) {
    if (!(key in c)) continue;
    const list = c[key];
    if (!Array.isArray(list) || !list.length) problem(`${at}: ${key} が空`);
    else if (list.some((d) => typeof d !== 'string' || !/^[a-z0-9_.-]+$/.test(d))) problem(`${at}: ${key} に不正なドメイン`);
  }
  for (const key of ['resourceTypes', 'excludedResourceTypes']) {
    if (!(key in c)) continue;
    const list = c[key];
    if (!Array.isArray(list) || !list.length) problem(`${at}: ${key} が空`);
    else if (list.some((t) => !RESOURCE_TYPES.has(t))) problem(`${at}: ${key} に不正な種類`);
  }
  for (const key of ['requestMethods', 'excludedRequestMethods']) {
    if (key in c && (!Array.isArray(c[key]) || !c[key].length || c[key].some((m) => !METHODS.has(m)))) {
      problem(`${at}: ${key} が不正`);
    }
  }
  if (c.domainType && c.domainType !== 'firstParty' && c.domainType !== 'thirdParty') problem(`${at}: domainType が不正`);
}

const TABLE_RE = /^\(self\.__adbanScriptlets \|\|= \[\]\)\.push\(JSON\.parse\(("[^\n]*")\)\);\n$/;

async function checkScriptlets(id, path) {
  const { shards } = await readJson(path);
  for (const [k, hosts] of Object.entries(shards ?? {})) {
    const file = `rules/scriptlets/${id}.${k}.js`;
    if (!(await exists(file))) {
      problem(`スクリプレットの表がない: ${file}`);
      continue;
    }
    // example.*（エンティティ）も入る。service worker が TLD の一覧に展開して match pattern にする
    if (hosts.some((h) => !/^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/.test(h) && !/^[a-z0-9_-]+(\.[a-z0-9_-]+)*\.\*$/.test(h))) problem(`${path}: 不正なホスト名`);
    const m = TABLE_RE.exec(await readFile(new URL(file, root), 'utf8'));
    if (!m) {
      problem(`${file}: 形が違う`);
      continue;
    }
    const table = JSON.parse(JSON.parse(m[1]));
    for (const [name] of table.entries) if (!Object.hasOwn(SCRIPTLETS, name)) problem(`${file}: 知らないスクリプレット ${name}`);
    const indexes = [...Object.values(table.add), ...Object.values(table.remove)].flat();
    if (indexes.some((i) => i !== -1 && !table.entries[i])) problem(`${file}: 番号が範囲外`);
    if (Object.keys(table.add).sort().join() !== [...hosts].sort().join()) problem(`${file}: ${path} とサイトが合わない`);
  }
}

const manifest = await readJson('manifest.json');

// tools/build-filters.mjs の LISTS（取得するリスト）と、manifest のルールセットの ID・順番が合っているか
const isDevTree = await exists('tools/build-filters.mjs');
{
  const source = isDevTree ? await readFile(new URL('tools/build-filters.mjs', root), 'utf8') : null;
  const listsBody = /export const LISTS = \[([\s\S]*?)\n\];/.exec(source)?.[1] ?? '';
  const listIds = [...listsBody.matchAll(/\bid: '([a-z0-9]+)'/g)].map((m) => m[1]);
  const rulesets = manifest.declarative_net_request.rule_resources;
  if (isDevTree && listIds.join() !== rulesets.map((r) => r.id).join()) {
    problem(`build-filters.mjs の LISTS (${listIds.join(',')}) と manifest のルールセット (${rulesets.map((r) => r.id).join(',')}) の ID・順番が合っていない`);
  }
  for (const r of rulesets) {
    if (r.path !== `rules/${r.id}.json`) problem(`manifest: ${r.id} のパスが rules/${r.id}.json ではない`);
  }
}

// manifest が指すファイル
const files = [
  manifest.background.service_worker,
  manifest.action.default_popup,
  manifest.options_ui.page,
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon),
  ...manifest.content_scripts.flatMap((s) => s.js ?? []),
  'content/yt-main.js',
  'content/picker.js',
  'content/scriptlets.js',
  ...RESOURCE_FILES.map((f) => `resources/${f}`),
];
for (const file of files) if (!(await exists(file))) problem(`ファイルがない: ${file}`);
if (!manifest.web_accessible_resources?.some((r) => r.resources.includes('resources/*'))) {
  problem('resources/ が web_accessible_resources にない（$redirect の差し替え先として読めない）');
}

// ルールセット
const meta = await readJson('rules/meta.json');
let total = 0;
let totalRegex = 0;
for (const { id, path } of manifest.declarative_net_request.rule_resources) {
  if (!(await exists(path))) {
    problem(`ルールセット ${id} のファイルがない: ${path}（node tools/build-filters.mjs を実行）`);
    continue;
  }
  const rules = await readJson(path);
  if (!Array.isArray(rules)) {
    problem(`${path}: 配列ではない`);
    continue;
  }
  const ids = new Set();
  for (const rule of rules) {
    if (ids.has(rule.id)) problem(`${path}: id ${rule.id} が重複`);
    ids.add(rule.id);
    checkRule(rule, path);
  }
  total += rules.length;
  const regexRules = rules.filter((r) => r.condition && 'regexFilter' in r.condition).length;
  totalRegex += regexRules;
  if (regexRules > MAX_REGEX_RULES) problem(`${path}: 正規表現ルールが ${regexRules} 件（上限 ${MAX_REGEX_RULES}）`);

  const cosmeticPath = `rules/${id}.cosmetic.json`;
  if (!(await exists(cosmeticPath))) problem(`要素隠しのファイルがない: ${cosmeticPath}`);
  else {
    const c = await readJson(cosmeticPath);
    for (const key of ['classes', 'ids', 'complex', 'genericHide', 'elemHide']) {
      if (!Array.isArray(c[key])) problem(`${cosmeticPath}: ${key} が配列ではない`);
    }
    for (const s of [...c.complex, ...Object.values(c.specific).flat(), ...Object.values(c.styles ?? {}).flat()]) {
      if (/[{}]|\/\*/.test(s)) problem(`${cosmeticPath}: CSS を壊す選択子 ${s}`);
    }
    // 手続き型の選択子は、拡張機能が実行時に解析する。解析できないものが入っていないか
    for (const s of Object.values(c.procedural ?? {}).flat()) {
      if (!parseProcedural(s)) problem(`${cosmeticPath}: 解析できない手続き型の選択子 ${s}`);
    }
  }

  // スクリプレット（rules/<id>.scriptlets.json が指す表と、その中身）
  const info = meta.lists.find((l) => l.id === id);
  const scriptletPath = `rules/${id}.scriptlets.json`;
  if (info?.scriptlets) {
    if (!(await exists(scriptletPath))) problem(`スクリプレットのファイルがない: ${scriptletPath}`);
    else await checkScriptlets(id, scriptletPath);
  } else if (await exists(scriptletPath)) {
    problem(`${scriptletPath} があるのに rules/meta.json の件数が 0`);
  }
  if (!meta.lists.some((l) => l.id === id)) problem(`rules/meta.json に ${id} がない`);
  console.log(`  ${id}: ${rules.length} ルール`);
}
console.log(`  合計: ${total} ルール（正規表現 ${totalRegex} 件）`);
// Chrome が保証する静的ルールは 30,000 件。ほかの拡張機能と共有の枠に頼らないよう、28,000 件までにする
if (total > MAX_STATIC_RULES) problem(`静的ルールが全体で ${total} 件（目安の上限 ${MAX_STATIC_RULES}）`);
// 正規表現ルールの上限は、拡張機能のすべての静的ルールセットを合わせて数える
if (totalRegex > MAX_REGEX_RULES) problem(`正規表現ルールが全体で ${totalRegex} 件（上限 ${MAX_REGEX_RULES}）`);

// 配布用パッケージ: manifest・meta.json・rules/ のファイルが過不足なく対応しているか（外したリストのファイルや項目が残っていないか）
if (!isDevTree) {
  const ids = manifest.declarative_net_request.rule_resources.map((r) => r.id);
  const metaIds = meta.lists.map((l) => l.id);
  if (ids.join() !== metaIds.join()) problem(`rules/meta.json のリスト (${metaIds.join(',')}) と manifest のルールセット (${ids.join(',')}) が合っていない`);
  const known = new Set(['meta.json', 'popups.json']);
  for (const id of ids) {
    known.add(`${id}.json`);
    known.add(`${id}.cosmetic.json`);
    if (meta.lists.find((l) => l.id === id)?.scriptlets) known.add(`${id}.scriptlets.json`);
  }
  for (const name of await readdir(new URL('rules/', root))) {
    if (name === 'scriptlets') {
      for (const f of await readdir(new URL('rules/scriptlets/', root))) {
        if (!ids.some((id) => f.startsWith(`${id}.`)) || !f.endsWith('.js')) problem(`rules/scriptlets/${f}: manifest にないリストのファイル`);
      }
    } else if (!known.has(name)) problem(`rules/${name}: manifest・meta.json に対応しないファイル`);
  }
}

// $popup のデータ（rules/popups.json。まだ作っていなければ飛ばす）
if (await exists('rules/popups.json')) {
  const popups = await readJson('rules/popups.json');
  const size = (await stat(new URL('rules/popups.json', root))).size;
  if (size > 300 * 1024) problem(`rules/popups.json が ${Math.round(size / 1024)}KB（目安は 300KB 以下）`);
  try {
    // すべての正規表現を作ってみて、読めないものがないか確かめる
    for (const [id, data] of Object.entries(popups.lists ?? {})) {
      if (!meta.lists.some((l) => l.id === id)) problem(`rules/popups.json に知らないリスト ${id}`);
      for (const side of [data.b, data.a].filter(Boolean)) {
        for (const item of side.p ?? []) new RegExp(patternToRegexSource(typeof item === 'string' ? item : item[0]), 'i');
        for (const item of side.r ?? []) new RegExp(typeof item === 'string' ? item : item[0], 'i');
      }
    }
    new PopupMatcher(Object.values(popups.lists ?? {})).match('https://example.com/', 'https://example.org/');
  } catch (e) {
    problem(`rules/popups.json が読めない: ${e.message}`);
  }
  console.log(`  popups.json: ${Math.round(size / 1024)}KB`);
}

if (problems.length) {
  console.error(`\n問題が ${problems.length} 件あります:`);
  for (const p of problems.slice(0, 50)) console.error(`  - ${p}`);
  process.exitCode = 1;
} else {
  console.log('\n問題は見つかりませんでした。');
}
