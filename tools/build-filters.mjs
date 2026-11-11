// フィルターリストを取得し、拡張機能が読む形（rules/ の各ファイル）に変換する。
//   rules/<id>.json            … declarativeNetRequest の静的ルール
//   rules/<id>.cosmetic.json   … 要素隠しのデータ
//   rules/scriptlets/<id>.<n>.js … ページで動かすスクリプレットの表（content/scriptlets.js が読む）
//   rules/<id>.scriptlets.json   … 表ごとの、スクリプレットを入れるサイトの一覧（service worker が登録に使う）
//   rules/popups.json          … $popup（広告のポップアップを閉じる）のデータ。全リスト分（popup-blocker.js が読む）
//   rules/meta.json            … 件数と更新日
//
//   node tools/build-filters.mjs            … すべてのリストを取得し直す
//   node tools/build-filters.mjs --offline  … filters/base.txt だけ変換する（取得済みのリストはそのまま）
//   node tools/build-filters.mjs --force    … 取得内容が前回と同じでも書き直す（変換のしくみを直したあとなど）
//
// 書き出しは、全リストの変換が終わってから一時ディレクトリ（rules/.tmp-build/）にまとめて行い、成功したら順に置き換える（meta.json は最後）。
// 取得内容の SHA-256 を meta.json の hash に持ち、前回と同じリストは書き直さない。全部同じなら meta.json（updated）も変えない。
// 実行したあと、拡張機能は meta.json の変化を見て自動で再読み込みする（設定で切れる）。手動なら chrome://extensions の再読み込みボタン。

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import https from 'node:https';
import { resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compileFilterList, findBadfilters } from '../lib/filters.js';
import { compilePopupText } from '../lib/popup.js';

const defaultRoot = new URL('../', import.meta.url);

// manifest.json の declarative_net_request.rule_resources と同じ順番・ID にする。
// 静的ルールの上限を超えたときは前のものから優先して有効になるため、重要なものほど前に置く。
export const LISTS = [
  { id: 'base', name: 'ADBAN 基本フィルター', file: 'filters/base.txt' },
  { id: 'easylist', name: 'EasyList', url: 'https://easylist.to/easylist/easylist.txt' },
  { id: 'japanese', name: 'AdGuard 日本語フィルター', url: 'https://filters.adtidy.org/extension/ublock/filters/7.txt' },
  {
    id: 'ubo',
    name: 'uBlock filters（広告ブロッカー対策への対策など）',
    url: 'https://ublockorigin.github.io/uAssetsCDN/filters/filters.min.txt',
  },
  { id: 'easyprivacy', name: 'EasyPrivacy（トラッカー）', url: 'https://easylist.to/easylist/easyprivacy.txt' },
  {
    id: 'unbreak',
    name: 'uBlock filters – Unbreak（ブロックで壊れるサイトの修正）',
    url: 'https://ublockorigin.github.io/uAssetsCDN/filters/unbreak.min.txt',
  },
  // ここから下は重要なものから順に並べる（上限を超えたとき、前のものから有効になる）
  {
    id: 'quickfixes',
    name: 'uBlock filters – Quick fixes（素早い修正）',
    url: 'https://ublockorigin.github.io/uAssetsCDN/filters/quick-fixes.min.txt',
  },
  {
    id: 'badware',
    name: 'uBlock filters – Badware risks（悪質サイト）',
    url: 'https://ublockorigin.github.io/uAssetsCDN/filters/badware.min.txt',
  },
  {
    id: 'peterlowe',
    name: "Peter Lowe's Ad and tracking server list（広告・トラッカーのサーバー名）",
    url: 'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=1&mimetype=plaintext',
  },
  {
    id: 'privacy',
    name: 'uBlock filters – Privacy（トラッカー）',
    url: 'https://ublockorigin.github.io/uAssetsCDN/filters/privacy.min.txt',
  },
  {
    id: 'adguarddns',
    name: 'AdGuard DNS フィルター（広告・トラッカーのホスト名）',
    url: 'https://adguardteam.github.io/HostlistsRegistry/assets/filter_1.txt',
    noExceptions: true, // 例外（@@）は取り込まない（DNS 用の都合の例外が、ほかのリストのブロックを打ち消してしまうため）
  },
];

// fetch() は Node 24 で取得中にプロセスごと落ちることがあったため、https モジュールで取得する
function download(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': 'ADBAN filter builder' }, timeout: 60_000 }, (res) => {
      const { statusCode, headers } = res;
      if (statusCode >= 300 && statusCode < 400 && headers.location && redirects > 0) {
        res.resume();
        resolve(download(new URL(headers.location, url).href, redirects - 1));
        return;
      }
      if (statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('タイムアウト')));
    req.on('error', reject);
  });
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const JSON_LINE = (data) => `${JSON.stringify(data)}\n`;

// スクリプレットの表は大きい（uBlock filters だけで 2 万サイト以上）ので、サイトごとに SCRIPTLET_SHARDS 個に分けて、
// ページには自分のサイトの分だけを入れる。分け方は「ホスト名の最後の 2 つ（example.com など）」で決めるので、
// あるサイトとそのサブドメイン向けのもの（例外も含む）は、どのリストでも必ず同じ番号のファイルに入る。
const SCRIPTLET_SHARDS = 16;
const shardOf = (host) => {
  let h = 0;
  for (const c of host.split('.').slice(-2).join('.')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % SCRIPTLET_SHARDS;
};

// スクリプレットの表を、書き出すファイルの一覧（ルートからの相対パス → 中身）にする
function scriptletFiles(id, table) {
  const files = new Map();
  if (!table) return files;
  const shards = {};
  for (let k = 0; k < SCRIPTLET_SHARDS; k++) {
    const pick = (map) => Object.entries(map).filter(([host]) => shardOf(host) === k);
    const add = pick(table.add);
    const remove = pick(table.remove);
    if (!add.length) continue;
    // このファイルで使う処理だけを残し、番号を振り直す
    const entries = [];
    const renumber = new Map([[-1, -1]]);
    const use = (list) =>
      list.map((i) => {
        if (!renumber.has(i)) renumber.set(i, entries.push(table.entries[i]) - 1);
        return renumber.get(i);
      });
    const part = {
      entries,
      add: Object.fromEntries(add.map(([host, list]) => [host, use(list)])),
      remove: Object.fromEntries(remove.map(([host, list]) => [host, use(list)])),
    };
    // JSON.parse に渡す形にすると、大きなオブジェクトを書くより速く読める
    const data = JSON.stringify(JSON.stringify(part));
    files.set(`rules/scriptlets/${id}.${k}.js`, `(self.__adbanScriptlets ||= []).push(JSON.parse(${data}));\n`);
    shards[k] = add.map(([host]) => host);
  }
  files.set(`rules/${id}.scriptlets.json`, JSON_LINE({ shards }));
  return files;
}

async function readJsonOr(url, fallback) {
  try {
    return JSON.parse(await readFile(url, 'utf8'));
  } catch {
    return fallback;
  }
}

// rename は原子的だが、Windows では読んでいる相手がいると一時的に失敗することがあるので、少し待ってやり直す
async function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try {
      await rename(from, to);
      return;
    } catch (e) {
      if (i >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      await sleep(250);
    }
  }
}

/**
 * リストを取得・変換して、root の rules/ を更新する。
 *   root       … 拡張機能のフォルダー（URL かパス。既定はこのリポジトリ）
 *   lists      … 取得するリスト（既定は LISTS）
 *   offline    … file のあるリストだけ変換する
 *   force      … 取得内容が前回と同じでも書き直す
 *   readText   … リストの本文を返す関数（テスト用に差し替えられる）
 *   now        … 更新日時を返す関数（テスト用）
 * 全リストの取得と変換が終わってから、一時ディレクトリにまとめて書き、すべて成功したら順に置き換える（meta.json は最後）。
 * 取得内容が前回と変わらないリストは書き直さず、全部変わらなければ何も書かない（meta.json の updated も変えない）。
 */
export async function build({
  root: rootArg = defaultRoot,
  lists = LISTS,
  offline = false,
  force = false,
  readText,
  now = () => new Date(),
  log = console.log,
  warn = console.warn,
} = {}) {
  const base = rootArg instanceof URL ? rootArg : pathToFileURL(resolve(String(rootArg)) + sep);
  const at = (rel) => new URL(rel, base);
  const read = readText ?? ((list) => (list.file ? readFile(at(list.file), 'utf8') : download(list.url)));

  const meta = await readJsonOr(at('rules/meta.json'), { lists: [] });
  if (!Array.isArray(meta.lists)) meta.lists = [];
  // $popup のデータ。--offline や取得失敗のときは、前回のリストの分をそのまま残す
  const popups = { v: 1, lists: {} };
  Object.assign(popups.lists, (await readJsonOr(at('rules/popups.json'), {})).lists);

  // 先にすべて取得してから変換する（変換中に待たせた接続が切れて fetch が落ちることがあるため）
  const targets = lists.filter((list) => !offline || list.file);
  const texts = await Promise.allSettled(targets.map((list) => read(list)));

  // $badfilter は別のリストのフィルターを打ち消すことがあるので、先にすべてのリストから集める
  const badfilters = new Set(texts.flatMap((t) => (t.status === 'fulfilled' ? findBadfilters(t.value) : [])));

  // 書き出すもの（rel → 中身）と、書き直したリストが持っていた古いスクリプレットのファイルを消すための目印
  const files = new Map();
  const staleOf = []; // { id, keep: Set<rel> }
  let failed = 0;
  let changedLists = 0;

  for (const [i, list] of targets.entries()) {
    const { status, value: text, reason } = texts[i];
    if (status === 'rejected') {
      failed++;
      warn(`× ${list.name}: 取得できませんでした（${reason.message}）。前回の内容を使います。`);
      continue;
    }
    const hash = sha256(text);
    const previous = meta.lists.find((l) => l.id === list.id);
    if (!force && previous?.hash === hash) {
      log(`＝ ${list.name}: 前回から変わっていません`);
      continue;
    }
    // DNS 向けのリストの例外（@@）は、DNS で止めると壊れるものを通すためのもの。ほかのリストのブロックまで打ち消してしまうので取り込まない
    const source = list.noExceptions ? text.split(/\r?\n/).filter((line) => !line.startsWith('@@')).join('\n') : text;
    const { rules, cosmetic, scriptlets, stats } = compileFilterList(source, { badfilters });
    files.set(`rules/${list.id}.json`, JSON_LINE(rules));
    files.set(`rules/${list.id}.cosmetic.json`, JSON_LINE(cosmetic));
    const scriptletOut = scriptletFiles(list.id, stats.scriptlet ? scriptlets.toJSON() : null);
    for (const [rel, content] of scriptletOut) files.set(rel, content);
    staleOf.push({ id: list.id, keep: new Set(scriptletOut.keys()) });
    const popup = compilePopupText(text, { badfilters });
    if (Object.keys(popup.data).length) popups.lists[list.id] = popup.data;
    else delete popups.lists[list.id];
    const popupCount = popup.stats.block + popup.stats.allow;
    const popupDropped = Object.values(popup.stats.dropped).reduce((n, c) => n + c, 0);

    const cosmeticCount =
      cosmetic.classes.length +
      cosmetic.ids.length +
      cosmetic.complex.length +
      Object.values(cosmetic.specific).reduce((n, s) => n + s.length, 0) +
      Object.values(cosmetic.styles).reduce((n, s) => n + s.length, 0);
    const entry = {
      id: list.id,
      name: list.name,
      source: list.url ?? list.file,
      updated: now().toISOString(),
      hash,
      rules: rules.length,
      network: stats.network,
      cosmetic: cosmeticCount,
      scriptlets: stats.scriptlet,
      popups: popupCount,
    };
    meta.lists = [...meta.lists.filter((l) => l.id !== list.id), entry];
    changedLists++;
    log(
      `✓ ${list.name}: ルール ${rules.length} 件・要素隠し ${cosmeticCount} 件・スクリプレット ${stats.scriptlet} 件・ポップアップ ${popupCount} 件` +
        (popupDropped ? `（対応外 ${popupDropped}）` : '') +
        `（読んだ行: ネットワーク ${stats.network} / 要素隠し ${stats.cosmetic} / 対応外 ${stats.skipped}）`,
    );
  }

  const total = meta.lists.reduce((n, l) => n + l.rules, 0);
  if (!changedLists) {
    log('更新されたリストはありません。rules/ は書き換えませんでした。');
  } else {
    files.set('rules/popups.json', JSON_LINE(popups));
    meta.lists.sort((a, b) => lists.findIndex((l) => l.id === a.id) - lists.findIndex((l) => l.id === b.id));
    const metaText = JSON_LINE(meta);

    // 1. 一時ディレクトリにすべて書く（ここで失敗しても rules/ は元のまま）。名前が _ で始まるディレクトリは Chrome が拒否する
    const tmp = at('rules/.tmp-build/');
    await rm(tmp, { recursive: true, force: true });
    try {
      for (const [rel, content] of [...files, ['rules/meta.json', metaText]]) {
        const dest = new URL(rel.slice('rules/'.length), tmp);
        await mkdir(new URL('./', dest), { recursive: true });
        await writeFile(dest, content);
      }
      // 2. すべて書けたら、ファイルを 1 つずつ（rename で原子的に）置き換える。meta.json は最後
      await mkdir(at('rules/scriptlets/'), { recursive: true });
      for (const rel of files.keys()) {
        await renameRetry(new URL(rel.slice('rules/'.length), tmp), at(rel));
      }
      // 書き直したリストの、もう使わないスクリプレットのファイルを消す
      const existing = await readdir(at('rules/scriptlets/'));
      for (const { id, keep } of staleOf) {
        if (!keep.size) await rm(at(`rules/${id}.scriptlets.json`), { force: true });
        for (const name of existing) {
          if (name.startsWith(`${id}.`) && !keep.has(`rules/scriptlets/${name}`)) await rm(at(`rules/scriptlets/${name}`), { force: true });
        }
      }
      await renameRetry(new URL('meta.json', tmp), at('rules/meta.json'));
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  }

  log(`静的ルールの合計: ${total} 件`);
  if (total > 30000) {
    warn('  ※ 30,000 件を超えています。ブラウザー全体の空きが足りないと、後ろのリストが有効にならないことがあります。');
  }
  return { changed: changedLists > 0, changedLists, failed, total };
}

// コマンドとして実行されたときだけ動かす（テストから import できるように）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { failed } = await build({
    offline: process.argv.includes('--offline'),
    force: process.argv.includes('--force'),
  });
  if (failed) process.exitCode = 1;
}

