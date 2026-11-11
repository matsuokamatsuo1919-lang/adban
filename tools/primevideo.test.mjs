// Prime Video の広告検出に使う、DOM に依存しない関数のテスト。
// content/cosmetic.js は ES module にできないので、globalThis.__adbanExport を用意した空の環境で読み込み、
// 関数を取り出す（コードの写しは持たない）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../content/cosmetic.js', import.meta.url), 'utf8');
const api = {};
vm.runInNewContext(source, { __adbanExport: api, URL, console });
const {
  parseRemaining, credibleRemaining, isAdTimerText, hasAdWord, hasSkipWord, hasClock, isInterestingText,
  isSkipText, safeDiagText, safePath, safeResource, deltaFrames, fitEvent,
} = api;

// vm の別の環境で作られたオブジェクトは prototype が違うので、比べる前に素の値にする
const plain = (v) => JSON.parse(JSON.stringify(v));

test('関数が取り出せる', () => {
  for (const name of ['parseRemaining', 'isAdTimerText', 'safeDiagText', 'fitEvent', 'safeResource']) {
    assert.equal(typeof api[name], 'function', name);
  }
});

// 広告のタイマーとして読めるべき文字列と、そこから読める残り秒数
const timers = [
  ['広告 0:15', 15],
  ['広告 1/2 0:15', 15],
  ['広告 1 / 2 0:15', 15],
  ['広告 1 of 2 0:30', 30],
  ['広告（1/2）0:20', 20],
  ['広告 · 0:09', 9],
  ['広告 | 残り 0:12', 12],
  ['広告 残り 0:45', 45],
  ['広告の残り 0:45', 45],
  ['広告 あと 15 秒', 15],
  ['広告 あと15秒', 15],
  ['広告 1/2 あと 8 秒', 8],
  ['広告 30秒', 30],
  ['広告 1:02:03', 3723],
  ['Ad 0:15', 15],
  ['Ad 1 of 2 0:30', 30],
  ['Ad 1 of 2 • 0:30', 30],
  ['Ad 1 / 2 · 0:30', 30],
  ['Ads 0:20', 20],
  ['Ad · 15s', 15],
  ['Ad ends in 0:10', 10],
  ['Ad 1 of 3 – 15 sec', 15],
  ['ad 0:15', 15],
  ['AD 0:07', 7],
  ['広告 0:15 / 0:30', 30],
  ['プレミアム広告 1/2 0:15', 15],
  ['再生中 広告 1/2 0:15', 15],
];
for (const [text, sec] of timers) {
  test(`広告のタイマー: ${text}`, () => {
    assert.ok(isAdTimerText(text), '検出されない');
    assert.equal(parseRemaining(text), sec);
  });
}

// 広告のタイマーと読んではいけないもの（本編の UI の文字など）
const notTimers = [
  '0:15',
  '1:42:00',
  'Read 0:15',
  'Upload 1:30',
  'Add 0:15',
  'Head 0:20',
  '広告',
  'Ad',
  '広告について',
  'スキップ 0:05',
  'Skip Intro 0:05',
  '第1話 0:42:00',
  '広告つき 0:15', // 「つき」は許す語に入れていない
  'Pad 1:00',
  '',
];
for (const text of notTimers) {
  test(`広告のタイマーではない: ${JSON.stringify(text)}`, () => {
    assert.equal(isAdTimerText(text), false);
  });
}

test('parseRemaining: 読めないものは null', () => {
  assert.equal(parseRemaining(''), null);
  assert.equal(parseRemaining('広告'), null);
  assert.equal(parseRemaining('Ad 1 of 2'), null);
  assert.equal(parseRemaining(null), null);
  assert.equal(parseRemaining(undefined), null);
  assert.equal(parseRemaining(15), null);
});

test('parseRemaining: 時刻以外の形', () => {
  assert.equal(parseRemaining('15'), 15);
  assert.equal(parseRemaining(' 15 '), 15);
  assert.equal(parseRemaining('15秒'), 15);
  assert.equal(parseRemaining('0:20'), 20);
  assert.equal(parseRemaining('1:02:03'), 3723);
  assert.equal(parseRemaining('12s'), 12);
  assert.equal(parseRemaining('12 secs'), 12);
});

test('credibleRemaining: 本編の長さを読み違えた値は捨てる', () => {
  assert.equal(credibleRemaining(15), 15);
  assert.equal(credibleRemaining(600), 600);
  assert.equal(credibleRemaining(5400), null);
  assert.equal(credibleRemaining(null), null);
});

test('広告・スキップ・時刻の語の判定', () => {
  assert.ok(hasAdWord('広告'));
  assert.ok(hasAdWord('Ad'));
  assert.ok(hasAdWord('Ads'));
  assert.ok(hasAdWord('Sponsored'));
  assert.ok(hasAdWord('スポンサー'));
  assert.ok(hasAdWord('広告をスキップ'));
  assert.ok(!hasAdWord('Add to list'));
  assert.ok(!hasAdWord('Download'));
  assert.ok(hasSkipWord('スキップ'));
  assert.ok(hasSkipWord('Skip'));
  assert.ok(hasSkipWord('Skip Intro'));
  assert.ok(!hasSkipWord('Skipper'));
  assert.ok(hasClock('0:15'));
  assert.ok(hasClock('広告 0:15'));
  assert.ok(hasClock('0:15 / 1:42:00'));
  assert.ok(!hasClock('12345'));
  assert.ok(isInterestingText('広告 1/2'));
  assert.ok(!isInterestingText('第 1 話'));
});

test('スキップボタンの文言: 広告のスキップだけ通す', () => {
  for (const ok of ['スキップ', '広告をスキップ', '広告スキップ', 'Skip', 'Skip Ad', 'Skip Ads', 'スキップ 5', 'Skip 5s']) {
    assert.ok(isSkipText(ok), ok);
  }
  for (const ng of ['イントロをスキップ', 'Skip Intro', 'Skip Recap', 'エンディングをスキップ', 'Skip Beat', '', '広告']) {
    assert.ok(!isSkipText(ng), JSON.stringify(ng));
  }
});

test('safeDiagText: 広告の語・数字・記号だけのものを通し、作品名らしいものは伏せる', () => {
  for (const ok of ['広告', 'Ad', '広告 1/2 0:15', 'Ad 1 of 2 0:30', 'スキップ', 'Skip', '0:15 / 1:42:00', '広告 あと 15 秒']) {
    assert.equal(safeDiagText(ok), ok.replace(/\s+/g, ' '), ok);
  }
  for (const ng of ['Skip Beat', '鬼滅の刃 第1話', 'Ad Astra', 'ウィッチャー 0:15', 'x'.repeat(41), '', null]) {
    assert.equal(safeDiagText(ng), null, String(ng));
  }
});

test('safePath: 作品を特定できる ID は * にする', () => {
  assert.equal(safePath('/gp/video/detail/B0ABCDEFGH/ref=atv'), '/gp/video/detail/*/ref=atv');
  assert.equal(safePath('/detail/amzn1.dv.gti.1234abcd-0000-1111-2222-333344445555'), '/detail/*');
  assert.equal(safePath('/gp/video/storefront'), '/gp/video/storefront');
  assert.equal(safePath(''), '');
});

test('safeResource: クエリは捨て、広告・再生に関わる通信だけ残す', () => {
  const r = safeResource('https://atv-ps.amazon.com/cdp/catalog/GetPlaybackResources?token=SECRET&asin=B0ABCDEFGH');
  assert.deepEqual(plain(r), { host: 'atv-ps.amazon.com', path: '/cdp/catalog/GetPlaybackResources' });
  assert.ok(!JSON.stringify(r).includes('SECRET'));
  assert.deepEqual(plain(safeResource('https://cdn.example.net/dash/B0ABCDEFGH/manifest.mpd?x=1')), {
    host: 'cdn.example.net',
    path: '/dash/*/manifest.mpd',
  });
  assert.equal(safeResource('https://example.com/static/logo.png'), null);
  assert.equal(safeResource('https://example.com/load/header.js'), null); // "ad" を含む語は除く
  assert.ok(safeResource('https://example.com/v1/ads/slot'));
  assert.equal(safeResource('not a url'), null);
  assert.equal(safeResource('https://example.com/a?playback=1'), null); // クエリだけに語がある
});

test('deltaFrames: 直前と同じ elements は省く', () => {
  const e = [{ tag: 'span', text: '広告' }];
  const frames = deltaFrames([{ elements: e }, { elements: [...e] }, { elements: [] }, { elements: [] }]);
  assert.ok('elements' in frames[0]);
  assert.ok(!('elements' in frames[1]));
  assert.ok('elements' in frames[2]);
  assert.ok(!('elements' in frames[3]));
});

test('fitEvent: 1 件 20KB に収める', () => {
  const el = { tag: 'span', class: 'c'.repeat(120), testid: 't'.repeat(60), aria: '', text: '広告', visible: true, rendered: true, w: 10, h: 10 };
  const frame = () => ({
    ms: 1,
    video: { playing: true },
    detect: { found: true },
    elements: Array.from({ length: 20 }, () => ({ ...el })),
    requests: Array.from({ length: 10 }, () => ({ host: 'h'.repeat(50), path: '/p'.repeat(50), type: 'fetch' })),
  });
  const ev = { id: 1, before: Array.from({ length: 10 }, frame), after: Array.from({ length: 20 }, frame) };
  assert.ok(JSON.stringify(ev).length > 20000);
  fitEvent(ev);
  assert.ok(JSON.stringify(ev).length <= 20000);
  assert.ok(ev.after.length >= 1);
  const small = { id: 2, before: [frame()], after: [] };
  small.before[0].elements.length = 1;
  small.before[0].requests.length = 0;
  const before = JSON.stringify(small);
  fitEvent(small);
  assert.equal(JSON.stringify(small), before); // 収まっているものは変えない
});
