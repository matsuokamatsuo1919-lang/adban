// 公開用のリポジトリ（GitHub に置くもの）の一式を dist/repo/ に作り、公開前に個人情報の点検をする。
//   node tools/prepare-repo.mjs [--dry-run] [--out <dir>]
//
//   --dry-run … 含めるファイルの一覧・合計の大きさ・点検の結果だけを出す（何も書かない）
//   --out     … 出力先（既定は dist/repo。最後の名前が「repo」のフォルダーだけ、作り直す）
//
// 除外リスト方式: .gitignore と同じ除外に加えて、store/（提出用の下書き）・dist/・tools/e2e/out/・_metadata/・.git/・node_modules/ を入れない。
// 点検に失敗したら、終了コード 1 で終わり、出力先は作らない（作ってしまった場合は消す）。
// git も gh も実行しない。最後に、公開の手順を表示するだけ。
//
// Copyright (C) 2026 ADBAN contributors. GNU General Public License v3.0 or later.

import { cp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const PUBLISHER_EMAIL = 'matsuokamatsuo1919@gmail.com';
export const GITHUB_USER = 'matsuokamatsuo1919-lang';
export const GITHUB_REPO = 'adban';

// ---- 除外 ----

// どの階層にあっても入れないフォルダー名
const EXCLUDED_DIR_NAMES = new Set(['.git', 'node_modules', '_metadata', '.tmp-build', ['.cla', 'ude'].join('')]);
// 入れないパス（先頭一致。/ 区切り）
const EXCLUDED_PREFIXES = ['store', 'dist', 'tools/e2e/out'];
// 入れないファイル名
const EXCLUDED_FILE = /(^|\/)(Thumbs\.db|\.DS_Store)$|\.(log|zip)$/i;

/** 公開するリポジトリに入れないパスか（rel は / 区切りの相対パス） */
export function isExcluded(rel) {
  const segs = rel.split('/');
  if (segs.some((s) => EXCLUDED_DIR_NAMES.has(s))) return true;
  if (EXCLUDED_PREFIXES.some((p) => rel === p || rel.startsWith(`${p}/`))) return true;
  return EXCLUDED_FILE.test(rel);
}

/** root の下の、公開するファイルの相対パス（/ 区切り、整列済み） */
export async function listPublicFiles(root) {
  const out = [];
  const walk = async (dir, rel) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (isExcluded(path)) continue;
      if (entry.isDirectory()) await walk(join(dir, entry.name), path);
      else if (entry.isFile()) out.push(path);
    }
  };
  await walk(root, '');
  return out.sort();
}

// ---- 個人情報の点検 ----

const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|bmp|zip|gz|woff2?|ttf|otf|eot|pdf|mp[34]|webm|ogg|wav)$/i;

// (a) 禁止語（大文字小文字を区別しない）。このファイル自身が点検に引っかからないよう、語は分けて書いて、あとでつなぐ
const part = (...p) => p.join('');
const FORBIDDEN_WORDS = [
  // 個人名の語は、rules/（公開のフィルターリストの変換結果）では、ドメイン名の一部（例: 実在の会社名）に偶然含まれるので調べない
  ['個人名・アカウント名（1）', new RegExp(part('ta', 'nit'), 'i')],
  ['個人名・アカウント名（2）', new RegExp(part('tani', 'uchi'), 'i')],
  ['個人名・アカウント名（3）', new RegExp(part('tak', 'uma'), 'i')],
  ['ユーザーフォルダーのパス', new RegExp(part(String.raw`[A-Z]:[\\/]+Us`, 'ers'), 'i')],
  ['アプリのデータフォルダー', new RegExp(part(String.raw`[\\/]App`, 'Data'), 'i')],
  ['設定フォルダー（ドット付き）', new RegExp(part(String.raw`\.cla`, 'ude'), 'i')],
  ['設定フォルダー（スラッシュ囲み）', new RegExp(part('/cla', 'ude/'), 'i')],
  ['作業用フォルダー', new RegExp(part('scratch', 'pad'), 'i')],
  ['開発者の個人環境のパス', new RegExp(part(String.raw`[A-Z]:[\\/]+AD`, 'BAN'), 'i')],
];

// (b) メールアドレスらしい文字列
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// 許可するもの（小文字で比べる）
const EMAIL_ALLOWED = (addr) => {
  const a = addr.toLowerCase();
  if (a === PUBLISHER_EMAIL) return true;
  if (a === 'noreply@anthropic.com') return true; // コミットの共著表記（Co-Authored-By）に使う、個人ではないアドレス
  return /@((?:[a-z0-9-]+\.)*example\.(com|org|net)|users\.noreply\.github\.com)$/.test(a);
};

// (c) 秘密らしいもの
const SECRET_PATTERNS = [
  ['GitHub のトークン', /\bgh[opsur]_[A-Za-z0-9]{16,}/],
  ['GitHub のトークン', /\bgithub_pat_[A-Za-z0-9_]{16,}/],
  ['Bearer トークン', /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/],
  ['秘密の値', /\b(?:api[_-]?key|secret|passw(?:or)?d)\s*[:=]\s*['"]?[A-Za-z0-9/+_.-]{8,}/i],
  ['秘密鍵', /-----BEGIN [A-Z ]*PRIVATE KEY/],
  ['AWS のキー', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['Google の API キー', /\bAIza[0-9A-Za-z_-]{35}\b/],
];

// (d) IP アドレスの固定値
const IP_RE = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g;
const IP_ALLOWED = new Set(['127.0.0.1', '0.0.0.0']);
// 文書用の範囲（RFC 5737）は、例として使ってよい
const IP_DOC_RANGE = /^(?:192\.0\.2|198\.51\.100|203\.0\.113)\./;
const validIp = (s) => s.split('.').every((n) => Number(n) <= 255 && String(Number(n)) === n);

const clip = (s) => (s.length > 60 ? `${s.slice(0, 57)}...` : s);

/**
 * 1 つのファイルの中身を点検して、{ file, line, kind, match } の一覧を返す。
 * 生成物（rules/）は、フィルターリストをそのまま変換したもので、サイトのパスやクエリに「secret」などの語が正当に現れるため、
 * 個人情報の語（a）・メール（b）・トークンの形（c のうち秘密鍵・GitHub・AWS・Google）だけを調べる。
 */
export function scanText(file, text) {
  const findings = [];
  const generated = file.startsWith('rules/');
  const lines = text.split(/\r?\n/);
  lines.forEach((lineText, i) => {
    const line = i + 1;
    const add = (kind, match) => findings.push({ file, line, kind, match: clip(match) });
    for (const [name, re] of FORBIDDEN_WORDS) {
      if (generated && name.startsWith('個人名')) continue;
      if (generated && name.startsWith('設定フォルダー')) continue; // ドメイン名の一部に偶然含まれる
      const m = lineText.match(re);
      if (m) add(`禁止語 ${name}`, m[0]);
    }
    for (const m of lineText.matchAll(EMAIL_RE)) if (!EMAIL_ALLOWED(m[0])) add('メールアドレス', m[0]);
    for (const [name, re] of SECRET_PATTERNS) {
      if (generated && (name === 'Bearer トークン' || name === '秘密の値')) continue;
      // テストの、ダミーの値を入れた変数名（secret: 'DUMMY' など）に反応しないよう、テストでは「秘密の値」を調べない
      if (/^tools\/[^/]+\.test\.mjs$/.test(file) && name === '秘密の値') continue;
      const m = lineText.match(re);
      if (m) add(`秘密らしいもの（${name}）`, m[0].replace(/(.{6}).*/, '$1…'));
    }
    if (!generated) {
      for (const m of lineText.matchAll(IP_RE)) {
        if (!validIp(m[0]) || IP_ALLOWED.has(m[0]) || IP_DOC_RANGE.test(m[0])) continue;
        // 「Chrome/131.0.0.0」のようなブラウザーの版は、IP アドレスではない
        if (lineText[m.index - 1] === '/') continue;
        add('IP アドレス', m[0]);
      }
    }
  });
  return findings;
}

/** root の下の paths（相対パス）を点検する。バイナリは除く */
export async function scanFiles(root, paths) {
  const findings = [];
  let scanned = 0;
  for (const rel of paths) {
    if (BINARY_EXT.test(rel)) continue;
    const buf = await readFile(join(root, ...rel.split('/')));
    if (buf.includes(0)) continue; // NUL を含むものはバイナリ
    scanned++;
    findings.push(...scanText(rel, buf.toString('utf8')));
  }
  return { findings, scanned };
}

// ---- 公開用のファイルがそろっているか ----

export const REQUIRED_PUBLIC_FILES = [
  'LICENSE',
  'README.md',
  'THIRD_PARTY_NOTICES.md',
  'SUPPORT.md',
  'CONTRIBUTING.md',
  'manifest.json',
  '.gitignore',
  '.gitattributes',
  '.github/ISSUE_TEMPLATE/ad-remains.yml',
  '.github/ISSUE_TEMPLATE/site-broken.yml',
  '.github/ISSUE_TEMPLATE/feature-request.yml',
  '.github/ISSUE_TEMPLATE/config.yml',
  '.github/pull_request_template.md',
  'docs/index.md',
  'docs/privacy.md',
  'docs/_config.yml',
];

export const missingPublicFiles = (paths) => REQUIRED_PUBLIC_FILES.filter((f) => !paths.includes(f));

// 置き換えていない URL の目印（tools/set-public-urls.mjs で置き換える）
const PLACEHOLDER_RE = /__(?:SUPPORT|SOURCE|PRIVACY)_URL__|<(?:プライバシーポリシー|ソースコード)の公開 URL[^>]*>|<サポート先[^>]*>/;

export async function findLeftoverPlaceholders(root, paths) {
  const out = [];
  for (const rel of paths) {
    // 目印の仕様を説明している自分自身（tools/）と、生成物・バイナリは除く
    if (BINARY_EXT.test(rel) || rel.startsWith('rules/') || rel.startsWith('tools/')) continue;
    const text = (await readFile(join(root, ...rel.split('/')))).toString('utf8');
    text.split(/\r?\n/).forEach((l, i) => {
      if (PLACEHOLDER_RE.test(l)) out.push({ file: rel, line: i + 1, match: clip(l.trim()) });
    });
  }
  return out;
}

// ---- 公開の手順（表示するだけ） ----

export function publishGuide({ user = GITHUB_USER, repo = GITHUB_REPO, dir = 'dist/repo' } = {}) {
  return `公開の手順（このスクリプトは実行しません。内容を確かめてから、自分で実行してください）

0. 準備: node tools/set-public-urls.mjs --user ${user} --repo ${repo} --apply で URL を置き換え、node tools/make-package.mjs で検証し、もう一度 node tools/prepare-repo.mjs を実行する。
1. 数字の ID を調べる（コミットの作者のメールアドレスに使う。実際のメールアドレスは使わない）:
     gh api user --jq .id
2. ${dir} に移って、リポジトリを作る:
     cd ${dir}
     git init -b main
     git config user.name "${user}"
     git config user.email "<ID>+${user}@users.noreply.github.com"
     git add -A
     git commit -m "ADBAN を公開"
3. GitHub に公開リポジトリを作って、送る:
     gh repo create ${user}/${repo} --public --source . --remote origin --push
4. Issue のラベルを作る（テンプレートのラベルが無いと、付かない）:
     gh label create "広告が残る" --repo ${user}/${repo}
     gh label create "表示が壊れる" --repo ${user}/${repo}
     gh label create "要望" --repo ${user}/${repo}
5. GitHub Pages を有効にする（main ブランチの /docs）:
     gh api -X POST repos/${user}/${repo}/pages -f "source[branch]=main" -f "source[path]=/docs"
   または、リポジトリの Settings > Pages で、Branch: main、Folder: /docs を選ぶ。
6. 公開後、https://github.com/${user}/${repo}/issues/new/choose と https://${user}.github.io/${repo}/privacy が開けることを確かめてから、ストアの申請に URL を入れる。
`;
}

// ---- コマンド ----

const fmtSize = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`);

async function totalSize(root, paths) {
  let t = 0;
  for (const p of paths) t += (await stat(join(root, ...p.split('/')))).size;
  return t;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const outIndex = args.indexOf('--out');
  const outDir = resolve(outIndex >= 0 ? args[outIndex + 1] : join(defaultRoot, 'dist', 'repo'));
  if (basename(outDir) !== 'repo') {
    console.error('作り直してよいのは「repo」という名前のフォルダーだけです。');
    process.exitCode = 1;
    return;
  }

  const paths = await listPublicFiles(defaultRoot);
  const size = await totalSize(defaultRoot, paths);
  const missing = missingPublicFiles(paths);

  if (dryRun) {
    console.log(`含めるファイル（${paths.length} ファイル、${fmtSize(size)}）:`);
    const byDir = new Map();
    for (const p of paths) {
      const top = p.includes('/') ? `${p.split('/')[0]}/` : '(直下)';
      byDir.set(top, (byDir.get(top) ?? 0) + 1);
    }
    for (const [d, n] of [...byDir].sort()) console.log(`  ${d.padEnd(12)} ${String(n).padStart(5)} ファイル`);
    for (const p of paths.filter((x) => !x.startsWith('rules/') && !x.startsWith('icons/'))) console.log(`    ${p}`);
  } else {
    await rm(outDir, { recursive: true, force: true });
    for (const rel of paths) {
      const dest = join(outDir, ...rel.split('/'));
      await mkdir(dirname(dest), { recursive: true });
      await cp(join(defaultRoot, ...rel.split('/')), dest);
    }
  }

  // 点検は、コピーしたもの（dry-run のときは元）に対して行う
  const scanRoot = dryRun ? defaultRoot : outDir;
  const { findings, scanned } = await scanFiles(scanRoot, paths);
  const placeholders = await findLeftoverPlaceholders(scanRoot, paths);
  console.log(`\n個人情報の点検: ${scanned} ファイルを調べました。`);

  let failed = false;
  if (findings.length) {
    failed = true;
    console.error(`見つかったもの: ${findings.length} 件`);
    for (const f of findings) console.error(`  ${f.file}:${f.line}  [${f.kind}]  ${f.match}`);
  } else {
    console.log('  問題は見つかりませんでした。');
  }
  if (missing.length) {
    failed = true;
    console.error(`公開に必要なファイルがありません:\n${missing.map((m) => `  ${m}`).join('\n')}`);
  }
  if (placeholders.length) {
    console.warn(`警告: 置き換えていない URL の目印があります（${placeholders.length} 件）。node tools/set-public-urls.mjs で置き換えてください:`);
    for (const f of placeholders) console.warn(`  ${f.file}:${f.line}  ${f.match}`);
  }

  if (failed) {
    if (!dryRun) await rm(outDir, { recursive: true, force: true });
    console.error('\n失敗しました（点検に通るまで、公開しないでください）。');
    process.exitCode = 1;
    return;
  }
  if (!dryRun) console.log(`\n${outDir} に ${paths.length} ファイル（${fmtSize(size)}）を作りました。`);
  console.log(`\n${publishGuide()}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
