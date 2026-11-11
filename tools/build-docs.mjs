// GitHub Pages で公開する docs/privacy.md を、store/privacy-policy.ja.md と store/privacy-policy.en.md から作る。
//   node tools/build-docs.mjs [--check] [--root <dir>]
//
//   --check … 書き出さず、docs/privacy.md が今の元の文書から作ったものと一致しているかだけ調べる（違えば終了コード 1）
//   --root  … 元のフォルダー（既定はこのリポジトリ。テスト用）
//
// 日本語を先、英語を後にして 1 ページにまとめる。見出しは 1 段下げる（# → ##、## → ###）。冒頭に、2 つの言語への目次を付ける。
// docs/privacy.md は生成物なので、直接編集しない（store/ の文書を直して、このスクリプトを実行する）。
//
// Copyright (C) 2026 ADBAN contributors. GNU General Public License v3.0 or later.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 見出しの階層を 1 段下げる（コードブロックの中は変えない） */
export function demoteHeadings(md) {
  let inFence = false;
  return md
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
      if (!inFence && /^#{1,5}\s/.test(line)) return `#${line}`;
      return line;
    })
    .join('\n');
}

/** ja・en の Markdown（store/ の文書の中身）から、docs/privacy.md の中身を作る */
export function buildPrivacy(ja, en) {
  const body = (md) => demoteHeadings(md.replace(/\r\n/g, '\n').trim());
  return [
    '---',
    'layout: page',
    'title: プライバシーポリシー / Privacy Policy',
    '---',
    '',
    '<!-- このファイルは tools/build-docs.mjs が store/privacy-policy.ja.md と store/privacy-policy.en.md から作ります。直接編集しないでください。 -->',
    '',
    '- [日本語（プライバシーポリシー）](#ja)',
    '- [English (Privacy Policy)](#en)',
    '',
    '<a id="ja"></a>',
    '',
    body(ja),
    '',
    '---',
    '',
    '<a id="en"></a>',
    '',
    body(en),
    '',
  ].join('\n');
}

/** root の下の文書から作った docs/privacy.md の中身 */
export async function generate(root = defaultRoot) {
  const ja = await readFile(join(root, 'store', 'privacy-policy.ja.md'), 'utf8');
  const en = await readFile(join(root, 'store', 'privacy-policy.en.md'), 'utf8');
  return buildPrivacy(ja, en);
}

/** docs/privacy.md が生成したものと一致しているか。{ ok, reason } */
export async function checkDocs(root = defaultRoot) {
  const expected = await generate(root);
  let actual;
  try {
    actual = await readFile(join(root, 'docs', 'privacy.md'), 'utf8');
  } catch {
    return { ok: false, reason: 'docs/privacy.md がありません' };
  }
  if (actual.replace(/\r\n/g, '\n') !== expected) return { ok: false, reason: 'docs/privacy.md が、store/ の文書から作ったものと違います' };
  return { ok: true, reason: '' };
}

export async function writeDocs(root = defaultRoot) {
  const out = join(root, 'docs', 'privacy.md');
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, await generate(root));
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const rootIndex = args.indexOf('--root');
  const root = resolve(rootIndex >= 0 ? args[rootIndex + 1] : defaultRoot);
  if (args.includes('--check')) {
    const { ok, reason } = await checkDocs(root);
    if (ok) console.log('docs/privacy.md は、store/ の文書と一致しています。');
    else {
      console.error(`${reason}。node tools/build-docs.mjs を実行して作り直してください。`);
      process.exitCode = 1;
    }
    return;
  }
  console.log(`${await writeDocs(root)} を作りました。`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
