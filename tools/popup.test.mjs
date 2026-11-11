// lib/popup.js（$popup の変換と判定）の単体テスト。
//   node --test "tools/*.test.mjs"

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PopupMatcher, compilePopupLines, compilePopupText, parsePopupFilter, registrableDomain } from '../lib/popup.js';

// フィルターの行 → 判定する道具
const matcher = (...lines) => new PopupMatcher([compilePopupLines(lines).data]);
const verdict = (m, url, source = 'https://news.example.com/article') => m.match(url, source);

test('$popup のない行は対象外（null）', () => {
  assert.equal(parsePopupFilter('||ads.example.com^'), null);
  assert.equal(parsePopupFilter('||ads.example.com^$script,third-party'), null);
  assert.equal(parsePopupFilter('example.com##.ad'), null);
  assert.equal(parsePopupFilter('||x.com^$~popup'), null);
  assert.equal(parsePopupFilter('||x.com^$popup,badfilter'), null);
});

test('||host^ はそのホストとサブドメインに一致し、似た別のホストには一致しない', () => {
  const m = matcher('||bad-ads.com^$popup');
  assert.equal(verdict(m, 'https://bad-ads.com/x'), 'block');
  assert.equal(verdict(m, 'http://www.bad-ads.com:8080/x?y=1'), 'block');
  assert.equal(verdict(m, 'https://notbad-ads.com/x'), null);
  assert.equal(verdict(m, 'https://bad-ads.com.example.org/x'), null);
  assert.equal(verdict(m, 'https://example.org/bad-ads.com/'), null);
});

test('||host/path^ はパスも見る。区切り（^）は文字の続きには一致しない', () => {
  const m = matcher('||devuploads.com/next^$popup');
  assert.equal(verdict(m, 'https://devuploads.com/next'), 'block');
  assert.equal(verdict(m, 'https://devuploads.com/next/a'), 'block');
  assert.equal(verdict(m, 'https://devuploads.com/next?x=1'), 'block');
  assert.equal(verdict(m, 'https://devuploads.com/nextpage'), null);
  assert.equal(verdict(m, 'https://devuploads.com/other'), null);
});

test('ポート付きのパターン', () => {
  const m = matcher('||localhost:8081/ad^$popup');
  assert.equal(verdict(m, 'http://localhost:8081/ad'), 'block');
  assert.equal(verdict(m, 'http://localhost:8082/ad'), null);
});

test('* と | と ^ を含む一般のパターン', () => {
  const m = matcher('/earn.php?z=$popup,subdocument', '|https://ex.com/a*b|$popup', '?key=*&submetric=$popup,3p');
  assert.equal(verdict(m, 'https://any.example/earn.php?z=12'), 'block');
  assert.equal(verdict(m, 'https://ex.com/axxb'), 'block');
  assert.equal(verdict(m, 'https://ex.com/axxbc'), null); // 末尾の | は終わりを指す
  assert.equal(verdict(m, 'http://ex.com/axxb'), null); // 先頭の | は始まりを指す
  assert.equal(verdict(m, 'https://other.example/p?key=1&submetric=2', 'https://news.example.com/'), 'block');
  assert.equal(verdict(m, 'https://other.example/p?key=1&submetric=2', 'https://other.example/'), null); // 3p のみ
});

test('正規表現のフィルター', () => {
  const m = matcher('/^https?:\\/\\/(?:ak\\.)?[a-z0-9]{5,15}\\.(?:com|net)\\/1\\/\\d{7}/$doc,frame,popup');
  assert.equal(verdict(m, 'https://abcde12.com/1/1234567'), 'block');
  assert.equal(verdict(m, 'https://abcde12.org/1/1234567'), null);
  assert.deepEqual(parsePopupFilter('/(?<n>a)\\k<n>x/$popup'), { drop: '後方参照・名前付きグループの正規表現' });
  assert.equal(parsePopupFilter('/(((/$popup').drop, '正規表現が JavaScript で読めない');
});

test('domain=（元のページ）。~ は除外、サブドメインも対象', () => {
  const m = matcher('||bit.ly^$popup,domain=eurogamer.net|~live.eurogamer.net');
  assert.equal(verdict(m, 'https://bit.ly/a', 'https://www.eurogamer.net/x'), 'block');
  assert.equal(verdict(m, 'https://bit.ly/a', 'https://live.eurogamer.net/x'), null);
  assert.equal(verdict(m, 'https://bit.ly/a', 'https://other.com/x'), null);
  assert.equal(verdict(m, 'https://bit.ly/a', ''), null); // 元のページが分からないときは閉じない
});

test('domain=example.* はよく使う TLD に一致する', () => {
  const m = matcher('||x-ads.net^$popup,domain=fuckingfast.*');
  assert.equal(verdict(m, 'https://x-ads.net/a', 'https://fuckingfast.net/'), 'block');
  assert.equal(verdict(m, 'https://x-ads.net/a', 'https://www.fuckingfast.co.uk/'), 'block');
  assert.equal(verdict(m, 'https://x-ads.net/a', 'https://fuckingfast/'), null);
  assert.equal(verdict(m, 'https://x-ads.net/a', 'https://notfuckingfast.com/'), null);
});

test('third-party / first-party は登録可能なドメインで比べる', () => {
  const third = matcher('||t.example^$popup,3p');
  assert.equal(verdict(third, 'https://t.example/x', 'https://news.other.com/'), 'block');
  assert.equal(verdict(third, 'https://t.example/x', 'https://www.t.example/'), null);
  const first = matcher('||t.example^$popup,first-party');
  assert.equal(verdict(first, 'https://t.example/x', 'https://sub.t.example/'), 'block');
  assert.equal(verdict(first, 'https://t.example/x', 'https://other.com/'), null);
  assert.equal(registrableDomain('a.b.example.co.jp'), 'example.co.jp');
  assert.equal(registrableDomain('www.example.com'), 'example.com');
  assert.equal(registrableDomain('127.0.0.1'), '127.0.0.1');
});

test('to= は開く先のドメイン。パターンなし（*）でも条件があれば使える', () => {
  const m = matcher('*$3p,popup,to=~com|~io|~good.net,from=files.example');
  assert.equal(verdict(m, 'https://evil.xyz/a', 'https://files.example/d'), 'block');
  assert.equal(verdict(m, 'https://ok.com/a', 'https://files.example/d'), null);
  assert.equal(verdict(m, 'https://x.good.net/a', 'https://files.example/d'), null);
  assert.equal(verdict(m, 'https://evil.xyz/a', 'https://other.example/d'), null);
});

test('条件のない全ポップアップ（$popup だけ）は使わない', () => {
  assert.deepEqual(parsePopupFilter('$popup'), { drop: '条件のない全ポップアップ' });
  assert.deepEqual(parsePopupFilter('*$popup'), { drop: '条件のない全ポップアップ' });
  assert.ok(parsePopupFilter('$popup,domain=a.com').filter);
});

test('例外（@@）は、そのブロックを打ち消す', () => {
  const m = matcher('||ads.example^$popup', '@@||ads.example/ok^$popup', '@@||trusted.example^$popup');
  assert.equal(verdict(m, 'https://ads.example/ad'), 'block');
  assert.equal(verdict(m, 'https://ads.example/ok'), 'allow');
  assert.equal(verdict(m, 'https://ads.example/ok?x=1'), 'allow');
  assert.equal(verdict(m, 'https://trusted.example/'), null); // ブロックがなければ null
  assert.equal(verdict(matcher('||t.example^$popup', '@@||t.example^$popup'), 'https://t.example/'), 'allow');
});

test('元のページ限定の例外 @@...$popup,domain=', () => {
  const m = matcher('||pay.example^$popup', '@@||pay.example^$popup,domain=shop.example');
  assert.equal(verdict(m, 'https://pay.example/', 'https://shop.example/'), 'allow');
  assert.equal(verdict(m, 'https://pay.example/', 'https://other.example/'), 'block');
});

test('important のブロックは、通常の例外に勝つ', () => {
  const m = matcher('||t.example^$popup,important', '@@||t.example^$popup');
  assert.equal(verdict(m, 'https://t.example/'), 'block');
});

test('popup 以外のタイプ指定が併記されていても、popup の部分だけを使う', () => {
  const m = matcher('||sub.example^$popup,subdocument', '||doc.example^$doc,popup', '||img.example^$image');
  assert.equal(verdict(m, 'https://sub.example/'), 'block');
  assert.equal(verdict(m, 'https://doc.example/'), 'block');
  assert.equal(verdict(m, 'https://img.example/'), null); // popup でない行は別の担当
});

test('対応できないオプションの行は捨てて、理由ごとに数える', () => {
  const { data, stats } = compilePopupLines([
    '||a.example^$popup,csp=script-src',
    '||b.example^$popup,denyallow=x.com',
    '||c.example^$popup,denyallow=y.com',
    '||d.example^$popup,domain=/re/',
    '||e.example^$popup,domain=ok.com|/re/', // 含める側の読めない指定だけなら、読めたものを残す
    '||f.example^$popup,domain=~/re/', // 除外を落とすと止めすぎるので捨てる
    '||g.example^$popup',
  ]);
  assert.equal(stats.block, 2);
  assert.equal(stats.dropped['未対応のオプション: csp'], 1);
  assert.equal(stats.dropped['未対応のオプション: denyallow'], 2);
  assert.equal(stats.dropped['domain の指定が読めない（正規表現など）'], 1);
  assert.equal(stats.dropped['domain の読めない除外指定'], 1);
  assert.deepEqual(Object.keys(data.b.h).sort(), ['e.example', 'g.example']);
});

test('match-case のパターンは大文字小文字を区別する。通常は区別しない', () => {
  const sensitive = matcher('/Ad/Pop$popup,match-case');
  assert.equal(verdict(sensitive, 'https://x.example/Ad/Pop'), 'block');
  assert.equal(verdict(sensitive, 'https://x.example/ad/pop'), null);
  const loose = matcher('/Ad/Pop$popup');
  assert.equal(verdict(loose, 'https://x.example/ad/pop'), 'block');
  assert.equal(verdict(matcher('||BAD.example^$popup'), 'https://Bad.Example/'), 'block');
});

test('$badfilter で打ち消されたフィルターは使わない', () => {
  const lines = ['||a.example^$popup', '||b.example^$popup'];
  const { data } = compilePopupLines(lines, { badfilters: new Set(['||a.example^$popup']) });
  assert.deepEqual(Object.keys(data.b.h), ['b.example']);
});

test('一致しなければ何もしない（OAuth・決済・about:blank・http 以外）', () => {
  const m = matcher('||ads.example^$popup');
  assert.equal(verdict(m, 'https://accounts.google.com/o/oauth2/auth?client_id=1'), null);
  assert.equal(verdict(m, 'https://www.paypal.com/checkoutnow?token=1'), null);
  assert.equal(verdict(m, 'about:blank'), null);
  assert.equal(verdict(m, 'chrome://newtab/'), null);
  assert.equal(verdict(m, 'not a url'), null);
});

test('複数のリストと、別のリストの例外', () => {
  const a = compilePopupLines(['||t.example^$popup']).data;
  const b = compilePopupLines(['@@||t.example/ok^$popup']).data;
  const m = new PopupMatcher([a, b]);
  assert.equal(verdict(m, 'https://t.example/ad'), 'block');
  assert.equal(verdict(m, 'https://t.example/ok'), 'allow');
  assert.equal(new PopupMatcher([]).match('https://t.example/', ''), null);
});

test('リストの文章から。コメントと $popup のない行は読み飛ばす', () => {
  const { data, stats } = compilePopupText(['! コメント', '||ads.example^', 'example.com##.ad', '||pop.example^$popup', '@@||pop.example/ok^$popup'].join('\n'));
  assert.equal(stats.block, 1);
  assert.equal(stats.allow, 1);
  assert.deepEqual(data, { b: { h: { 'pop.example': 0 } }, a: { h: { 'pop.example': ['/ok^'] } } });
});

test('ホストのみ（条件なし）の項目は、同じホストの条件付きの項目をまとめる', () => {
  const { data } = compilePopupLines(['||t.example/a^$popup', '||t.example^$popup', '||t.example/b^$popup']);
  assert.deepEqual(data.b.h, { 't.example': 0 });
});

test('判定は速い（数千件のフィルターで 1 回 1ms 未満）', () => {
  const lines = [];
  for (let i = 0; i < 3000; i++) lines.push(`||ad${i}.example${i % 7}.com^$popup`);
  for (let i = 0; i < 200; i++) lines.push(`/pop${i}/*/go^$popup`, `||h${i}.example/p${i}^$popup,domain=a${i}.com`);
  const m = matcher(...lines);
  m.match('https://warm.example/', 'https://x.com/'); // 正規表現の準備
  const start = performance.now();
  const N = 2000;
  for (let i = 0; i < N; i++) m.match(`https://www.news${i}.example.org/article/${i}?utm=abc&x=1`, 'https://news.example.com/');
  const per = (performance.now() - start) / N;
  assert.ok(per < 1, `1 回 ${per.toFixed(3)}ms`);
});
