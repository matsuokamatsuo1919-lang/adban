// 公開用の URL を、目印（プレースホルダー）から実際の値に置き換える。
//   node tools/set-public-urls.mjs --user <GitHub のアカウント名> --repo <リポジトリ名> [--pages-url <URL>] [--apply] [--root <dir>]
//
//   --apply     … 書き換える。付けないと、変更の予定を表示するだけ（dry-run）
//   --pages-url … GitHub Pages の URL（既定は https://<user>.github.io/<repo>）
//   --root      … 対象のフォルダー（既定はこのリポジトリ。テスト用）
//
// 決まる URL:
//   サポート窓口（SUPPORT_URL）   https://github.com/<user>/<repo>/issues
//   ソースコード（SOURCE_URL）    https://github.com/<user>/<repo>
//   プライバシーポリシー（PRIVACY_URL） <pages-url>/privacy
//
// 置き換える対象:
//   (a) lib/support.js の 3 つの定数（SUPPORT_URL・SOURCE_URL・PRIVACY_URL。1 行ずつ。今の値が何であっても、新しい値に合わせる）
//       ファイルや定数が無いときは、その分をスキップして報告する
//   (b) store/listing.ja.md・store/listing.en.md・store/permissions-justification.md の <…> の目印
//       （プライバシーポリシーの公開 URL・ソースコードの公開 URL・サポート先 URL）
//       store/release-checklist.md など、目印そのものを説明している文書は対象にしない
//   (c) LICENSE・THIRD_PARTY_NOTICES.md に「ソースの入手先」の目印があれば、リポジトリの URL に
// 冪等: 2 回流しても同じ結果になる（置き換え済みなら「変更なし」）。置き換えた場所の一覧を出力する。
//
// Copyright (C) 2026 ADBAN contributors. GNU General Public License v3.0 or later.

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** user・repo・pagesUrl から、3 つの URL を決める */
export function buildUrls({ user, repo, pagesUrl }) {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(user ?? '')) throw new Error('--user は GitHub のアカウント名（英数字とハイフン）で指定してください');
  if (!/^[A-Za-z0-9._-]+$/.test(repo ?? '')) throw new Error('--repo はリポジトリ名で指定してください');
  const pages = (pagesUrl ?? `https://${user.toLowerCase()}.github.io/${repo}`).replace(/\/+$/, '');
  if (!/^https:\/\/[^\s/]+/.test(pages)) throw new Error('--pages-url は https:// で始まる URL で指定してください');
  return {
    SUPPORT_URL: `https://github.com/${user}/${repo}/issues`,
    SOURCE_URL: `https://github.com/${user}/${repo}`,
    PRIVACY_URL: `${pages}/privacy`,
  };
}

// store/ の文書の目印 → どの URL か
const DOC_MARKERS = [
  ['<プライバシーポリシーの公開 URL を入れてください>', 'PRIVACY_URL'],
  ['<ソースコードの公開 URL を入れてください>', 'SOURCE_URL'],
  ['<サポート先 URL を入れてください>', 'SUPPORT_URL'],
  ['<enter the public URL of the privacy policy>', 'PRIVACY_URL'],
  ['<enter the public URL of the source code>', 'SOURCE_URL'],
  ['<enter the support URL>', 'SUPPORT_URL'],
];
const DOC_FILES = ['store/listing.ja.md', 'store/listing.en.md', 'store/permissions-justification.md'];
// (c) ソースの入手先の目印
const SOURCE_MARKERS = [
  ['<ソースの入手先の URL を入れてください>', 'SOURCE_URL'],
  ['<enter the URL where the source code is available>', 'SOURCE_URL'],
];
const SOURCE_FILES = ['LICENSE', 'THIRD_PARTY_NOTICES.md'];
const CONSTANTS = ['SUPPORT_URL', 'SOURCE_URL', 'PRIVACY_URL'];

async function readIfExists(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

function replaceMarkers(file, text, markers, urls, changes) {
  let out = text;
  for (const [marker, key] of markers) {
    if (!out.includes(marker)) continue;
    out.split('\n').forEach((l, i) => {
      if (l.includes(marker)) changes.push({ file, line: i + 1, what: marker, to: urls[key] });
    });
    out = out.split(marker).join(urls[key]);
  }
  return out;
}

/**
 * 置き換えの計画を作る（書き込みはしない）。
 * 戻り値: { changes: [{ file, line, what, to }], skipped: [文字列], writes: Map(相対パス → 新しい中身) }
 */
export async function planUrls(root, urls) {
  const changes = [];
  const skipped = [];
  const writes = new Map();

  // (a) lib/support.js
  const supportText = await readIfExists(join(root, 'lib', 'support.js'));
  if (supportText === null) {
    skipped.push('lib/support.js がありません（3 つの定数をスキップ）');
  } else {
    let text = supportText;
    for (const name of CONSTANTS) {
      const re = new RegExp(`^(export const ${name} = ')([^']*)(';)`, 'm');
      const m = re.exec(text);
      if (!m) {
        skipped.push(`lib/support.js に ${name} の定義がありません（スキップ）`);
        continue;
      }
      if (m[2] === urls[name]) continue;
      const line = text.slice(0, m.index).split('\n').length;
      changes.push({ file: 'lib/support.js', line, what: `${name}（${m[2]}）`, to: urls[name] });
      text = text.replace(re, (_, a, _b, c) => `${a}${urls[name]}${c}`);
    }
    if (text !== supportText) writes.set('lib/support.js', text);
  }

  // (b) store/ の文書、(c) ソースの入手先
  for (const [files, markers] of [[DOC_FILES, DOC_MARKERS], [SOURCE_FILES, SOURCE_MARKERS]]) {
    for (const file of files) {
      const text = await readIfExists(join(root, ...file.split('/')));
      if (text === null) continue;
      const out = replaceMarkers(file, text, markers, urls, changes);
      if (out !== text) writes.set(file, out);
    }
  }
  return { changes, skipped, writes };
}

export async function applyPlan(root, plan) {
  for (const [file, text] of plan.writes) await writeFile(join(root, ...file.split('/')), text);
}

function parseArgs(argv) {
  const opt = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') opt.apply = true;
    else if (a === '--user') opt.user = argv[++i];
    else if (a === '--repo') opt.repo = argv[++i];
    else if (a === '--pages-url') opt.pagesUrl = argv[++i];
    else if (a === '--root') opt.root = argv[++i];
    else throw new Error(`知らない引数です: ${a}`);
  }
  return opt;
}

async function main() {
  let opt;
  let urls;
  try {
    opt = parseArgs(process.argv.slice(2));
    urls = buildUrls(opt);
  } catch (e) {
    console.error(e.message);
    console.error('使い方: node tools/set-public-urls.mjs --user <アカウント名> --repo <リポジトリ名> [--pages-url <URL>] [--apply]');
    process.exitCode = 1;
    return;
  }
  const root = resolve(opt.root ?? defaultRoot);
  const plan = await planUrls(root, urls);

  console.log(`サポート窓口: ${urls.SUPPORT_URL}\nソースコード: ${urls.SOURCE_URL}\nプライバシーポリシー: ${urls.PRIVACY_URL}\n`);
  if (plan.changes.length === 0) console.log('置き換える場所はありません（変更なし）。');
  else {
    console.log(opt.apply ? '置き換えた場所:' : '置き換える予定の場所（--apply を付けると書き換えます）:');
    for (const c of plan.changes) console.log(`  ${c.file}:${c.line}  ${c.what} → ${c.to}`);
  }
  for (const s of plan.skipped) console.log(`スキップ: ${s}`);
  if (opt.apply) await applyPlan(root, plan);
  else if (plan.changes.length) console.log('\n(dry-run: 何も書き換えていません)');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
