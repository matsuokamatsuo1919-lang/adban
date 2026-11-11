// 公開用のリポジトリを作る道具（tools/prepare-repo.mjs・set-public-urls.mjs・build-docs.mjs）のテスト。
// 一時ディレクトリで、個人情報の点検・除外・URL の置き換え・docs の生成を確かめる。
// 禁止語や秘密らしい文字列は、このファイル自身が点検に引っかからないよう、分けて書いてあとでつなぐ。

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildPrivacy, checkDocs, demoteHeadings, writeDocs } from './build-docs.mjs';
import {
  PUBLISHER_EMAIL,
  isExcluded,
  listPublicFiles,
  missingPublicFiles,
  publishGuide,
  scanFiles,
  scanText,
} from './prepare-repo.mjs';
import { applyPlan, buildUrls, planUrls } from './set-public-urls.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const j = (...p) => p.join('');
const kinds = (findings) => findings.map((f) => f.kind);

async function withTmp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'adban-repo-test-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function put(root, rel, text) {
  const path = join(root, ...rel.split('/'));
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

// ---- 個人情報の点検 ----

test('点検: 個人名・個人環境のパス・設定フォルダーなどの禁止語を見つける（大文字小文字は区別しない）', () => {
  const words = [
    j('Ta', 'nita'),
    j('TANI', 'UCHI'),
    j('tak', 'uma'),
    j('C:\\Us', 'ers\\foo'),
    j('C:/Us', 'ers/foo'),
    j('C:\\Us', 'ers\\x\\App', 'Data\\Local'),
    j('~/.cla', 'ude/settings'),
    j('/home/x/cla', 'ude/projects'),
    j('the scratch', 'pad dir'),
    j('C:\\AD', 'BAN'),
    j('C:\\\\AD', 'BAN'),
  ];
  for (const w of words) {
    const found = scanText('a.md', `行 ${w} 行`);
    assert.ok(found.length >= 1, `見つからない: ${w}`);
    assert.equal(found[0].file, 'a.md');
    assert.equal(found[0].line, 1);
  }
  // 行番号
  assert.equal(scanText('a.md', `ok\nok\n${j('tak', 'uma')}`)[0].line, 3);
});

test('点検: 公開者以外のメールアドレスは失敗、許可リスト（公開者・example.com・noreply）は通す', () => {
  assert.deepEqual(kinds(scanText('a.md', j('someone@', 'gmail.com'))), ['メールアドレス']);
  assert.deepEqual(kinds(scanText('a.md', j('foo@', 'corp.co.jp'))), ['メールアドレス']);
  for (const ok of [PUBLISHER_EMAIL, PUBLISHER_EMAIL.toUpperCase(), 'user@example.com', 'a@sub.example.org', '12345+name@users.noreply.github.com']) {
    assert.deepEqual(scanText('a.md', `連絡先: ${ok}`), [], ok);
  }
  // メールではないもの
  assert.deepEqual(scanText('a.md', 'import x from "@scope/pkg"; v@1.2'), []);
});

test('点検: 秘密らしい文字列（トークン・Bearer・鍵・パスワード・AWS）を見つける', () => {
  const samples = [
    j('gh', 'p_', 'a'.repeat(30)),
    j('gh', 'o_', 'B'.repeat(30)),
    j('github', '_pat_', 'a1'.repeat(15)),
    j('Bear', 'er ', 'abcdef0123456789abcdef'),
    j('api', '_key = "', 'abcd1234efgh"'),
    j('pass', 'word=', 'hunter2hunter2'),
    j('sec', 'ret: "', 'abcdefgh1234"'),
    j('-----BE', 'GIN RSA PRIVATE KEY-----'),
    j('AK', 'IA', 'ABCDEFGHIJKLMNOP'),
  ];
  for (const s of samples) {
    const found = scanText('lib/a.js', s);
    assert.ok(found.some((f) => f.kind.startsWith('秘密らしいもの')), `見つからない: ${s}`);
    // 報告には値の全文を出さない
    assert.ok(found.every((f) => f.match.length <= 12 || !f.kind.startsWith('秘密らしいもの') || f.match.endsWith('…')));
  }
});

test('点検: 固定の IP アドレスは失敗、127.0.0.1・localhost・文書用の範囲・ブラウザーの版は通す', () => {
  assert.deepEqual(kinds(scanText('a.js', j('host 8.8.', '8.8'))), ['IP アドレス']);
  assert.deepEqual(kinds(scanText('a.js', j('host 192.168.', '1.20'))), ['IP アドレス']);
  for (const ok of ['127.0.0.1', 'localhost', '192.0.2.1', '203.0.113.7', 'Chrome/131.0.0.0 Safari', '999.1.1.1']) {
    assert.deepEqual(scanText('a.js', ok), [], ok);
  }
});

test('点検: 生成物（rules/）は、ドメイン名に偶然含まれる語や URL のクエリの語では失敗しない。個人環境のパスは見つける', () => {
  const domain = j('a8clk.shop.', 'tani', 'ta.co.jp');
  assert.deepEqual(scanText('rules/x.json', `"${domain}","${j('/cla', 'ude/')}","secret=abcdefgh12","${j('1.2.', '3.4')}"`), []);
  assert.ok(scanText('rules/x.json', j('C:\\Us', 'ers\\a')).length > 0);
  assert.ok(scanText('rules/x.json', j('gh', 'p_', 'a'.repeat(30))).length > 0);
});

test('点検: バイナリ（拡張子・NUL を含むもの）は調べず、テキストは調べる', async () => {
  await withTmp(async (root) => {
    const bad = j('C:\\Us', 'ers\\a');
    await put(root, 'icons/a.png', bad);
    await writeFile(join(root, 'bin.dat'), Buffer.concat([Buffer.from(bad), Buffer.from([0])]));
    await put(root, 'ok.md', '問題なし');
    await put(root, 'bad.md', `a\n${bad}`);
    const { findings, scanned } = await scanFiles(root, ['icons/a.png', 'bin.dat', 'ok.md', 'bad.md']);
    assert.equal(scanned, 2);
    assert.deepEqual(findings.map((f) => `${f.file}:${f.line}`), ['bad.md:2']);
  });
});

// ---- 除外 ----

test('除外: store/・dist/・tools/e2e/out/・_metadata/・.git/・node_modules/・ログ・zip は含めず、公開するものは含める', async () => {
  const excluded = [
    'store/privacy-policy.ja.md',
    'dist/repo/a.js',
    'tools/e2e/out/2026/report.json',
    '_metadata/verified_contents.json',
    '.git/config',
    'node_modules/x/index.js',
    'rules/.tmp-build/a.json',
    'tools/update-filters.log',
    'a.log',
    'adban-1.0.0.zip',
    'Thumbs.db',
    'sub/Thumbs.db',
    j('.cla', 'ude/settings.json'),
  ];
  const included = ['README.md', 'rules/base.json', 'tools/e2e/run.mjs', 'tools/e2e/README.md', '.github/pull_request_template.md', 'docs/index.md', '.gitignore', 'storefront.md'];
  for (const p of excluded) assert.ok(isExcluded(p), `含めてしまう: ${p}`);
  for (const p of included) assert.ok(!isExcluded(p), `除いてしまう: ${p}`);

  await withTmp(async (root) => {
    for (const p of [...excluded, ...included]) await put(root, p, 'x');
    assert.deepEqual(await listPublicFiles(root), [...included].sort());
  });
});

test('公開に必要なファイルが欠けていると見つける', () => {
  assert.ok(missingPublicFiles(['README.md']).includes('SUPPORT.md'));
  assert.ok(missingPublicFiles(['README.md']).includes('.github/ISSUE_TEMPLATE/ad-remains.yml'));
});

test('公開の手順: 実行はせず、noreply のメールアドレスと gh repo create を示す', () => {
  const guide = publishGuide();
  assert.match(guide, /users\.noreply\.github\.com/);
  assert.match(guide, /gh repo create matsuokamatsuo1919-lang\/adban --public/);
  assert.match(guide, /git init/);
});

// ---- 公開用の URL の置き換え ----

const URLS = buildUrls({ user: 'someone', repo: 'adban' });

const SUPPORT_JS = `// コメント
export const SUPPORT_URL = '__SUPPORT_URL__';
export const SOURCE_URL = '__SOURCE_URL__';
export const PRIVACY_URL = '__PRIVACY_URL__';
export const OTHER = 'keep';
`;
const LISTING = '詳しくは: <プライバシーポリシーの公開 URL を入れてください>\nソース: <ソースコードの公開 URL を入れてください>\nサポート: <サポート先 URL を入れてください>\n';
const CHECKLIST = '`listing.*.md` の `<サポート先 URL を入れてください>` を置き換える。\n';

test('set-public-urls: 3 つの URL を決める（pages-url の既定と指定）', () => {
  assert.deepEqual(URLS, {
    SUPPORT_URL: 'https://github.com/someone/adban/issues',
    SOURCE_URL: 'https://github.com/someone/adban',
    PRIVACY_URL: 'https://someone.github.io/adban/privacy',
  });
  assert.equal(buildUrls({ user: 'a', repo: 'b', pagesUrl: 'https://example.com/x/' }).PRIVACY_URL, 'https://example.com/x/privacy');
  assert.throws(() => buildUrls({ user: 'bad user', repo: 'b' }));
  assert.throws(() => buildUrls({ user: 'a', repo: 'b', pagesUrl: 'http://example.com' }));
});

test('set-public-urls: 目印を置き換え、2 回流しても同じ（冪等）。説明用の文書と、目印のない文書は変えない', async () => {
  await withTmp(async (root) => {
    await put(root, 'lib/support.js', SUPPORT_JS);
    await put(root, 'store/listing.ja.md', LISTING);
    await put(root, 'store/release-checklist.md', CHECKLIST);
    await put(root, 'README.md', '# 目印なし <b>text</b>\n');
    await put(root, 'LICENSE', 'GNU GPL\n');

    const dry = await planUrls(root, URLS);
    assert.equal(dry.changes.length, 6);
    assert.equal(await readFile(join(root, 'lib/support.js'), 'utf8'), SUPPORT_JS, 'dry-run では書かない');

    await applyPlan(root, dry);
    const js = await readFile(join(root, 'lib/support.js'), 'utf8');
    assert.match(js, /^export const SUPPORT_URL = 'https:\/\/github\.com\/someone\/adban\/issues';$/m);
    assert.match(js, /^export const SOURCE_URL = 'https:\/\/github\.com\/someone\/adban';$/m);
    assert.match(js, /^export const PRIVACY_URL = 'https:\/\/someone\.github\.io\/adban\/privacy';$/m);
    assert.match(js, /^export const OTHER = 'keep';$/m);
    const listing = await readFile(join(root, 'store/listing.ja.md'), 'utf8');
    assert.ok(listing.includes('https://someone.github.io/adban/privacy') && listing.includes('https://github.com/someone/adban/issues'));
    assert.ok(!listing.includes('<'));
    assert.equal(await readFile(join(root, 'store/release-checklist.md'), 'utf8'), CHECKLIST);
    assert.equal(await readFile(join(root, 'README.md'), 'utf8'), '# 目印なし <b>text</b>\n');

    const again = await planUrls(root, URLS);
    assert.equal(again.changes.length, 0);
    assert.equal(again.writes.size, 0);
  });
});

test('set-public-urls: lib/support.js が無い・定数が足りないときはスキップして報告する', async () => {
  await withTmp(async (root) => {
    await put(root, 'store/listing.en.md', 'Privacy: <enter the public URL of the privacy policy>\nSource: <enter the public URL of the source code>\n');
    const plan = await planUrls(root, URLS);
    assert.equal(plan.changes.length, 2);
    assert.ok(plan.skipped.some((s) => s.includes('lib/support.js')));

    await put(root, 'lib/support.js', "export const SUPPORT_URL = '__SUPPORT_URL__';\n");
    const plan2 = await planUrls(root, URLS);
    assert.ok(plan2.skipped.some((s) => s.includes('SOURCE_URL')));
    assert.ok(plan2.skipped.some((s) => s.includes('PRIVACY_URL')));
    assert.ok(plan2.changes.some((c) => c.file === 'lib/support.js' && c.what.startsWith('SUPPORT_URL')));
  });
});

test('set-public-urls（コマンド）: --apply なしは書かず、--apply で書く', async () => {
  await withTmp(async (root) => {
    await put(root, 'lib/support.js', SUPPORT_JS);
    const run = (...extra) =>
      spawnSync(process.execPath, [join(here, 'set-public-urls.mjs'), '--user', 'someone', '--repo', 'adban', '--root', root, ...extra], { encoding: 'utf8' });
    const dry = run();
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /dry-run/);
    assert.equal(await readFile(join(root, 'lib/support.js'), 'utf8'), SUPPORT_JS);
    assert.equal(run('--apply').status, 0);
    assert.match(await readFile(join(root, 'lib/support.js'), 'utf8'), /github\.com\/someone\/adban\/issues/);
    assert.notEqual(spawnSync(process.execPath, [join(here, 'set-public-urls.mjs'), '--repo', 'adban'], { encoding: 'utf8' }).status, 0);
  });
});

// ---- docs の生成 ----

const JA = '# ADBAN プライバシーポリシー\n\n## 1. 要約\n\n本文\n\n```\n# コードの中の行\n```\n';
const EN = '# ADBAN Privacy Policy\n\n## 1. Summary\n\nBody\n';

test('build-docs: 見出しを 1 段下げ（コードブロックの中は除く）、日本語・英語を 1 ページにまとめる', () => {
  assert.equal(demoteHeadings('# A\n## B\n```\n# C\n```\n#### D'), '## A\n### B\n```\n# C\n```\n##### D');
  const page = buildPrivacy(JA, EN);
  assert.match(page, /^---\nlayout: page\n/);
  assert.ok(page.indexOf('(#ja)') < page.indexOf('(#en)'));
  assert.ok(page.indexOf('## ADBAN プライバシーポリシー') < page.indexOf('## ADBAN Privacy Policy'));
  assert.ok(page.includes('### 1. 要約') && page.includes('### 1. Summary'));
  assert.ok(page.includes('\n# コードの中の行\n'));
});

test('build-docs --check: 生成済みなら通り、元の文書を変える・docs が無いと失敗する', async () => {
  await withTmp(async (root) => {
    await put(root, 'store/privacy-policy.ja.md', JA);
    await put(root, 'store/privacy-policy.en.md', EN);
    const cli = (...a) => spawnSync(process.execPath, [join(here, 'build-docs.mjs'), '--root', root, ...a], { encoding: 'utf8' });

    assert.equal((await checkDocs(root)).ok, false, 'docs が無い');
    assert.equal(cli('--check').status, 1);

    await writeDocs(root);
    assert.equal((await checkDocs(root)).ok, true);
    assert.equal(cli('--check').status, 0);

    await put(root, 'store/privacy-policy.ja.md', `${JA}\n追記\n`);
    assert.equal((await checkDocs(root)).ok, false);
    assert.equal(cli('--check').status, 1);

    assert.equal(cli().status, 0);
    assert.equal(cli('--check').status, 0);

    await writeFile(join(root, 'docs', 'privacy.md'), `${await readFile(join(root, 'docs', 'privacy.md'), 'utf8')}\n手で追記`);
    assert.equal(cli('--check').status, 1);
  });
});
