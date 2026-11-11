// lib/support.js（「問題を報告」の報告用の文章・サポート窓口の URL）のテスト。
//   node --test "tools/support.test.mjs"

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PRIVACY_URL, SOURCE_URL, SUPPORT_URL, buildReport, isConfigured, parseBrowser, parseOS, reportTarget } from '../lib/support.js';

const UA_CHROME_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.92 Safari/537.36';
const UA_EDGE_WIN = `${UA_CHROME_WIN} Edg/130.0.2849.56`;
const UA_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const UA_LINUX = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const UA_CROS = 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const meta = {
  lists: [
    { id: 'base', name: 'ADBAN 基本フィルター', updated: '2026-11-10T03:04:28.340Z' },
    { id: 'easylist', name: 'EasyList', updated: '2026-11-11T03:54:30.438Z' },
    { id: 'japanese', name: 'AdGuard 日本語フィルター', updated: '2026-11-09T00:00:00.000Z' },
  ],
};

const baseInfo = (over = {}) => ({
  version: '1.1.0',
  userAgent: UA_CHROME_WIN,
  meta,
  rulesetIds: ['base', 'easylist', 'japanese'],
  settings: {
    enabled: true,
    allowlist: ['secret-allowed-site.example', 'other.example'],
    customFilters: '! 私のメモ\n||my-private-tracker.example^\nexample.com##.my-secret-box\n\n',
    disabledRulesets: ['japanese'],
    youtubePrune: true,
    collapseSlots: false,
    collapsePromo: true,
    pvDiagEnabled: true,
  },
  tabUrl: 'https://www.example.com/path/to/article?id=12345&token=abc#section',
  blocked: 7,
  pvDiag: { events: [{ secret: 'PVDIAG-SECRET-CONTENT' }] },
  ...over,
});

test('報告用の文章: 必要な項目がそろっている', () => {
  const text = buildReport(baseInfo());
  for (const want of [
    '- ADBAN の版: 1.1.0',
    '- ブラウザー: Chrome 130.0.6723.92',
    '- OS: Windows',
    '- リストの更新日: 2026-11-11',
    '- 有効なリスト: ADBAN 基本フィルター、EasyList',
    '- 全体のブロック: オン',
    '- このサイトでのブロック: オン',
    '- YouTube の広告データの除去: オン',
    '- 空の広告枠のたたみ込み: オフ',
    '- 記事広告のたたみ込み: オン',
    '- ブロックしないサイト: 2 件',
    '- 自分で書いたフィルター: 2 行',
    '- Prime Video の診断の記録: オン',
    '- ドメイン名: www.example.com',
    '- このページで止めた件数: 7',
    '## 何が起きましたか',
    '## どのページ（URL）でしたか（書いても書かなくても構いません）',
    '## いつからですか',
  ]) {
    assert.ok(text.includes(want), `含まれていない: ${want}\n${text}`);
  }
  // 無効にしたリストは、一覧にも更新日にも入らない
  assert.ok(!text.includes('AdGuard 日本語フィルター'));
});

test('報告用の文章: URL 全文・パス・クエリ・ハッシュ・タイトルを含まない（ドメイン名だけ入る）', () => {
  const text = buildReport(baseInfo({ tabTitle: '秘密の記事のタイトル', title: '秘密の記事のタイトル' }));
  for (const bad of ['https://', '/path/to/article', 'id=12345', 'token=abc', '#section', '秘密の記事のタイトル', '?']) {
    assert.ok(!text.includes(bad), `含まれてはいけない: ${bad}`);
  }
  assert.ok(text.includes('www.example.com'));
});

test('報告用の文章: 自分で書いたフィルター・許可リストの中身・診断の中身を含まない（件数・行数だけ）', () => {
  const text = buildReport(baseInfo());
  for (const bad of ['my-private-tracker', 'my-secret-box', '私のメモ', 'secret-allowed-site', 'other.example', 'PVDIAG-SECRET-CONTENT', 'pvDiag']) {
    assert.ok(!text.includes(bad), `含まれてはいけない: ${bad}`);
  }
});

test('報告用の文章: userAgent の全文を含まない（ブラウザーの名前と版・OS の名前だけ）', () => {
  for (const ua of [UA_CHROME_WIN, UA_EDGE_WIN, UA_MAC, UA_LINUX, UA_CROS]) {
    const text = buildReport(baseInfo({ userAgent: ua }));
    for (const bad of ['Mozilla', 'AppleWebKit', 'KHTML', 'Safari/', 'Win64', 'NT 10.0', 'x86_64', 'Intel Mac']) {
      assert.ok(!text.includes(bad), `含まれてはいけない: ${bad}（${ua}）`);
    }
  }
});

test('ブラウザーと OS の判定: Chrome / Edge / macOS / Linux / ChromeOS / その他', () => {
  assert.deepEqual(parseBrowser(UA_CHROME_WIN), { name: 'Chrome', version: '130.0.6723.92' });
  assert.deepEqual(parseBrowser(UA_EDGE_WIN), { name: 'Edge', version: '130.0.2849.56' });
  assert.equal(parseBrowser('curl/8').name, 'その他');
  assert.equal(parseOS(UA_CHROME_WIN), 'Windows');
  assert.equal(parseOS(UA_MAC), 'macOS');
  assert.equal(parseOS(UA_LINUX), 'Linux');
  assert.equal(parseOS(UA_CROS), 'ChromeOS');
  assert.equal(parseOS('something else'), 'その他');
  assert.match(buildReport(baseInfo({ userAgent: UA_EDGE_WIN })), /- ブラウザー: Edge 130\.0\.2849\.56/);
});

test('報告用の文章: 対象外のタブ（chrome:// ・拡張機能のページ・空）は「なし」', () => {
  for (const tabUrl of ['chrome://extensions/', 'chrome-extension://abcdefghijklmnop/popup/popup.html', 'edge://settings', 'about:blank', 'file:///C:/secret/memo.txt', '']) {
    const text = buildReport(baseInfo({ tabUrl }));
    assert.ok(text.includes('- ドメイン名: なし'), tabUrl);
    assert.ok(text.includes('- このページで止めた件数: なし'), tabUrl);
    assert.ok(text.includes('- このサイトでのブロック: なし'), tabUrl);
    assert.ok(!text.includes('secret'.concat('/memo')), tabUrl);
  }
});

test('報告用の文章: このサイトでのブロック・全体のオフ・件数が分からないとき', () => {
  const off = buildReport(baseInfo({ tabUrl: 'https://sub.secret-allowed-site.example/x', settings: { ...baseInfo().settings, enabled: false } }));
  assert.ok(off.includes('- 全体のブロック: オフ'));
  assert.ok(off.includes('- このサイトでのブロック: オフ')); // 許可リストの親ドメインに当たる
  assert.ok(buildReport(baseInfo({ blocked: null })).includes('- このページで止めた件数: 不明'));
});

test('報告用の文章: 日本語の注意書きと、書き足す欄の見出しがある', () => {
  const text = buildReport(baseInfo());
  assert.ok(text.includes('個人情報（名前・メールアドレス・パスワード・住所など）は書かないでください'));
  assert.ok(text.includes('## 何が起きましたか'));
});

test('報告用の文章: 情報が足りなくても例外を出さない', () => {
  assert.doesNotThrow(() => buildReport());
  assert.doesNotThrow(() => buildReport({}));
  const text = buildReport({});
  assert.ok(text.includes('個人情報'));
});

test('isConfigured: 目印のままは未設定、https:// で始まれば設定済み', () => {
  assert.equal(isConfigured('__SUPPORT_URL__'), false);
  assert.equal(isConfigured(''), false);
  assert.equal(isConfigured(undefined), false);
  assert.equal(isConfigured('http://example.com/issues'), false);
  assert.equal(isConfigured('javascript:alert(1)'), false);
  assert.equal(isConfigured('https://github.com/a/b/issues'), true);
});

test('reportTarget: GitHub の Issues ならテンプレートを開く URL（クエリはテンプレート名だけ）', () => {
  const base = 'https://github.com/someone/adban/issues';
  assert.equal(reportTarget('ad-remains', base), `${base}/new?template=ad-remains.yml`);
  assert.equal(reportTarget('site-broken', base), `${base}/new?template=site-broken.yml`);
  assert.equal(reportTarget('other', base), `${base}/new?template=feature-request.yml`);
  assert.equal(reportTarget('unknown-kind', base), `${base}/new?template=feature-request.yml`);
  // 末尾の / があってもよい
  assert.equal(reportTarget('ad-remains', `${base}/`), `${base}/new?template=ad-remains.yml`);
  assert.equal(reportTarget('ad-remains', `${base}//`), `${base}/new?template=ad-remains.yml`);
  // クエリは template だけ
  assert.deepEqual([...new URL(reportTarget('ad-remains', base)).searchParams.keys()], ['template']);
});

test('reportTarget: GitHub 以外の URL はそのまま返す。未設定は null', () => {
  assert.equal(reportTarget('ad-remains', 'https://support.example.com/adban'), 'https://support.example.com/adban');
  assert.equal(reportTarget('other', 'https://example.com/form?x=1'), 'https://example.com/form?x=1');
  assert.equal(reportTarget('ad-remains', '__SUPPORT_URL__'), null);
  assert.equal(reportTarget('ad-remains', ''), null);
  assert.equal(reportTarget('ad-remains', 'http://insecure.example'), null);
});

test('lib/support.js: 目印の宣言が 1 行ずつで、外部へ送る処理（fetch の外部 URL・sendBeacon・WebSocket など）がない', async () => {
  const src = await readFile(new URL('../lib/support.js', import.meta.url), 'utf8');
  for (const name of ['SUPPORT_URL', 'SOURCE_URL', 'PRIVACY_URL']) {
    const lines = src.split('\n').filter((l) => l.startsWith(`export const ${name} = `));
    assert.equal(lines.length, 1, name);
    assert.match(lines[0], /^export const \w+ = '(?:__\w+__|https:\/\/[^']+)';$/);
  }
  for (const bad of ['sendBeacon', 'WebSocket', 'XMLHttpRequest', 'new Image', 'navigator.share']) assert.ok(!src.includes(bad), bad);
  // fetch は、拡張機能自身の rules/meta.json を読む 1 か所だけ
  assert.equal((src.match(/\bfetch\(/g) ?? []).length, 1);
  assert.ok(src.includes("fetch(chrome.runtime.getURL('rules/meta.json'))"));
});
