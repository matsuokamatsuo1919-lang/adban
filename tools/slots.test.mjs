// 広告の札の判定（content/slots.js の DOM に依存しない関数）のテスト。
// content/slots.js は ES module にできないので、globalThis.__adbanExport を用意した空の環境で読み込み、
// 関数を取り出す（コードの写しは持たない）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../content/slots.js', import.meta.url), 'utf8');
const api = {};
vm.runInNewContext(source, { __adbanExport: api, console });
const { normalizeLabel, isAdLabel, isBadgeText, hasPrClass } = api;

test('関数が取り出せる', () => {
  for (const name of ['normalizeLabel', 'isAdLabel', 'isBadgeText', 'hasPrClass']) assert.equal(typeof api[name], 'function', name);
});

test('normalizeLabel: 前後の空白・括弧・記号を落とし、全角と大文字をそろえる', () => {
  const cases = [
    ['  広告  ', '広告'],
    ['【PR】', 'pr'],
    ['［ＰＲ］', 'pr'],
    ['（pr）', 'pr'],
    ['(PR)', 'pr'],
    ['Advertisement ▼', 'advertisement'],
    ['ＡＤ', 'ad'],
    ['Sponsored\n', 'sponsored'],
    ['sponsored   content', 'sponsored content'],
    ['※広告※', '広告'],
    ['AD&D', 'ad&d'],
  ];
  for (const [input, expected] of cases) assert.equal(normalizeLabel(input), expected, input);
  assert.equal(normalizeLabel(null), '');
  assert.equal(normalizeLabel(42), '');
});

test('isAdLabel: 広告の札になるもの', () => {
  const yes = [
    'Advertisement', 'ADVERTISEMENT', 'advertising', 'Ad', 'AD', 'Ads', '広告', ' 広告 ', '広告枠',
    'スポンサー', 'スポンサード', 'スポンサードリンク', 'スポンサーリンク', 'Sponsored', 'Sponsored Content',
    'Sponsor', 'Promoted', 'Promotion', 'プロモーション', 'PR', 'pr', '【PR】', '［PR］', '[PR]', '(PR)', '（PR）',
    'PR記事', '広告記事', 'タイアップ', 'タイアップ記事', '提供', '広告 ▼', 'Ad.', 'ＰＲ',
  ];
  for (const t of yes) assert.equal(isAdLabel(t), true, t);
});

test('isAdLabel: 札にならないもの（本文中の語・別の意味の語）', () => {
  const no = [
    '広告について', 'PR会社', 'Prime', 'AD&D', 'Ad blocking', '広告の歴史', '広告主', 'Advertise with us',
    'Advertiser', 'Sponsors', 'Sponsored by Acme', 'Promotional', 'PR Newswire', 'プレスリリース', 'スポンサーシップ',
    '広告を掲載する', 'Ads by Google', 'Pro', 'Print', '', '   ', '【PR】新製品を発売', '広告広告', 'Add', 'ADHD',
    '広告 広告 広告 広告 広告 広告', // 20 文字を超える
  ];
  for (const t of no) assert.equal(isAdLabel(t), false, t);
  assert.equal(isAdLabel(undefined), false);
  assert.equal(isAdLabel(null), false);
  assert.equal(isAdLabel({}), false);
});

test('isBadgeText: カテゴリ名のような短い札（日付・数字・広告の札は除く）', () => {
  assert.equal(isBadgeText('家電'), true);
  assert.equal(isBadgeText('ニュース'), true);
  assert.equal(isBadgeText('Tech'), true);
  assert.equal(isBadgeText('2026/11/11'), false);
  assert.equal(isBadgeText('12:30'), false);
  assert.equal(isBadgeText('3件'), true);
  assert.equal(isBadgeText('1,200円'), false);
  assert.equal(isBadgeText('PR'), false);
  assert.equal(isBadgeText('広告'), false);
  assert.equal(isBadgeText('これは十文字を超える長い文字列です'), false);
  assert.equal(isBadgeText(''), false);
});

test('hasPrClass: class 名が PR の札を示すもの', () => {
  const yes = ['pr', 'c-feed_visual c-feed_visual-pr', 'is-pr', 'icon_pr', 'card sponsored', 'item-sponsored', 'PR', 'a  b   pr'];
  for (const c of yes) assert.equal(hasPrClass(c), true, c);
  const no = ['pr-4', 'md:pr-2 pl-2', 'print', 'press-release', 'product', 'pr4', 'sprite', 'app', 'prime', '', 'sponsors', 'pr-list'];
  for (const c of no) assert.equal(hasPrClass(c), false, c);
  assert.equal(hasPrClass(null), false);
  assert.equal(hasPrClass('x'.repeat(400) + ' pr'), false);
});
