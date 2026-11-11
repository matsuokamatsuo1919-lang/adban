// 手続き型の要素隠し（lib/filters.js の parseProcedural）と、エンティティ（lib/hosts.js の entityChain）のテスト。
// DOM に触る評価（content/procedural.js）は実ブラウザーで確かめる。  node --test "tools/*.test.mjs"

import assert from 'node:assert/strict';
import test from 'node:test';
import { CosmeticEngine } from '../lib/cosmetic.js';
import { compileFilterList, parseFilter, parseProcedural, splitTop } from '../lib/filters.js';
import { entityChain } from '../lib/hosts.js';

const one = (text) => {
  const r = parseProcedural(text);
  assert.ok(r, `解析できる: ${text}`);
  assert.equal(r.programs.length, 1, text);
  return r.programs[0];
};

test('テキストの演算子（:has-text・:contains・:-abp-contains）は、文字列と正規表現を区別する', () => {
  assert.deepEqual(one('.ad:has-text(広告)'), { c: '.ad', s: [['text', ['t', '広告']]] });
  assert.deepEqual(one('.ad:contains(広告)').s, [['text', ['t', '広告']]]);
  assert.deepEqual(one('.ad:-abp-contains(広告)').s, [['text', ['t', '広告']]]);
  assert.deepEqual(one('div:has-text(/^(Ad|広告)$/i)').s, [['text', ['r', '^(Ad|広告)$', 'i']]]);
  // 引用符は外す。括弧・カンマ・アポストロフィを含んでもよい
  assert.deepEqual(one('p:has-text("a (b), c")').s, [['text', ['t', 'a (b), c']]]);
  assert.deepEqual(one("p:has-text(Don't)").s, [['text', ['t', "Don't"]]]);
  // g・y フラグは捨てる（lastIndex の状態を持たせない）
  assert.deepEqual(one('p:has-text(/x/gi)').s, [['text', ['r', 'x', 'i']]]);
});

test('危ない・壊れた正規表現と引数は使わない', () => {
  for (const text of [
    'p:has-text(/(a+)+$/)', // 入れ子の繰り返し（ReDoS）
    'p:has-text(/(\\w*)*x/)',
    'p:has-text(/(a)\\1/)', // 後方参照
    'p:has-text(/[/)', // 正規表現として不正
    'p:has-text()',
    'p:has-text(abc', // 閉じていない
    'p:upward(0)',
    'p:upward(99)',
    'p:min-text-length(x)',
    'p:matches-css(color)',
    ':has-text(x)', // 基点がない（ページ全体を調べることになる）
    '> p:has-text(x)',
    'p:-abp-properties(*data:image*)', // 再現できない
    'p:matches-property(a)',
    'p:is(:has-text(x))', // :is の中の手続き型は取り出せない
    'p:style(color: red} a{x: y):has-text(a)',
    'p:remove():has-text(a)', // 操作はいちばん最後だけ
    'p:has-text(a):remove():style(color: red)',
  ]) {
    assert.equal(parseProcedural(text), null, text);
  }
});

test(':upward・:nth-ancestor・:xpath・:min-text-length', () => {
  assert.deepEqual(one('.a:upward(2)').s, [['up', 2]]);
  assert.deepEqual(one('.a:nth-ancestor(3)').s, [['up', 3]]);
  assert.deepEqual(one('.a:upward(div.card)').s, [['up', 'div.card']]);
  assert.deepEqual(one('img:xpath(../..)').s, [['xpath', '../..']]);
  // XPath の条件は入れ子の [] と引用符を含む
  assert.deepEqual(one('a:xpath(//div[contains(@class, "x")]//a[@t="_b" and not(@h=ancestor::div[1]/@h)])').s, [
    ['xpath', '//div[contains(@class, "x")]//a[@t="_b" and not(@h=ancestor::div[1]/@h)]'],
  ]);
  // 基点が空で :xpath だけのものは、ページ全体（:root）を起点にする
  assert.deepEqual(one(":xpath(//span[text()='Ad'])"), { c: ':root', s: [['xpath', "//span[text()='Ad']"]] });
  assert.deepEqual(one('p:min-text-length(80)').s, [['minlen', 80]]);
});

test(':matches-css・:matches-attr・:matches-media', () => {
  assert.deepEqual(one('a:matches-css(cursor: pointer)').s, [['mcss', 'cursor', ['e', 'pointer'], '']]);
  assert.deepEqual(one('a:matches-css-before(content: /^広告$/)').s, [['mcss', 'content', ['r', '^広告$', ''], '::before']]);
  assert.deepEqual(one('a:matches-css-after(content: *x*)').s, [['mcss', 'content', ['e', '*x*'], '::after']]);
  // 古い AdGuard の書き方
  assert.deepEqual(one('a:matches-css(before, content: /x/)').s, [['mcss', 'content', ['r', 'x', ''], '::before']]);
  assert.deepEqual(one('a:matches-attr("href"="/=[0-9a-f]{32}$/")').s, [['mattr', ['e', 'href'], ['r', '=[0-9a-f]{32}$', '']]]);
  assert.deepEqual(one('a:matches-attr("/^data-/")').s, [['mattr', ['r', '^data-', ''], null]]);
  assert.deepEqual(one('a:matches-attr(target=_blank)').s, [['mattr', ['e', 'target'], ['e', '_blank']]]);
  assert.deepEqual(one('h:matches-media((max-width: 767px))').s, [['mmedia', '(max-width: 767px)']]);
});

test(':matches-path はページの条件で、前後の CSS をつなげて基点にする', () => {
  assert.deepEqual(one(':matches-path(/jp/) .aside > .x'), { c: '.aside > .x', s: [], p: [['r', 'jp', '']] });
  assert.deepEqual(one(':matches-path(/special/coupon) div').p, [['t', '/special/coupon']]);
  assert.deepEqual(one('.a:has-text(x):matches-path(/a\\\\/b/)').p, [['r', 'a\\/b', '']]); // AdGuard の二重のバックスラッシュ
});

test(':has・:not・:if・:if-not は、中が手続き型のときだけ演算子になる', () => {
  // 純粋な CSS の :has は、基点の CSS の一部（ブラウザーが解釈する）
  assert.equal(parseProcedural('.a:has(.b)'), null);
  assert.deepEqual(one('.a:has(.b):has-text(x)'), { c: '.a:has(.b)', s: [['text', ['t', 'x']]] });
  assert.deepEqual(one('.a:has(> li > a:contains(で調べる))').s, [
    ['has', { c: '> li > a', s: [['text', ['t', 'で調べる']]] }],
  ]);
  assert.deepEqual(one('.a:-abp-has(span:-abp-contains(/Ad/))').s, [
    ['has', { c: 'span', s: [['text', ['r', 'Ad', '']]] }],
  ]);
  assert.deepEqual(one('.a:not(:has-text(x))').s, [['not', { c: '', s: [['text', ['t', 'x']]] }]]);
  assert.deepEqual(one('.a:if(.b):if-not(.c)').s, [
    ['has', { c: '.b', s: [] }],
    ['nothas', { c: '.c', s: [] }],
  ]);
  // 入れ子
  assert.deepEqual(one('li:has(a:not(:has-text(x)))').s[0][1].s[0][0], 'not');
});

test('演算子のあとに続く CSS は、子孫・兄弟・その要素自身の絞り込みになる', () => {
  assert.deepEqual(one('.a:has-text(x) > span').s, [['text', ['t', 'x']], ['sel', '> span']]);
  assert.deepEqual(one('.a:has-text(x) span.b').s[1], ['sel', 'span.b']);
  assert.deepEqual(one('.a:has-text(x) + .b').s[1], ['sib', '+ .b']);
  assert.deepEqual(one('.a:has-text(x):not(.c)').s[1], ['f', ':not(.c)']);
  assert.deepEqual(one('.a:upward(1):has-text(x):upward(2)').s, [['up', 1], ['text', ['t', 'x']], ['up', 2]]);
});

test('操作（:remove・:style・:remove-attr・:remove-class）は最後に 1 つ', () => {
  assert.deepEqual(one('.a:has-text(x):remove()').a, ['rm']);
  assert.deepEqual(one('.a:upward(2):style(display: none !important)').a, ['style', 'display: none !important']);
  assert.deepEqual(one('.a:contains(x):remove-attr(disabled)').a, ['ra', 'disabled']);
  assert.deepEqual(one('.a:contains(x):remove-class(is-locked)').a, ['rc', 'is-locked']);
  assert.deepEqual(one('.a:watch-attr(disabled):remove-class(x)'), { c: '.a', s: [], a: ['rc', 'x'], w: true });
  // 見た目の宣言は、CSS を壊すものを通さない
  assert.equal(parseProcedural('.a:has-text(x):style(background: url(https://evil.example/x))'), null);
  assert.deepEqual(one('.a:has-text(x):style(--h: 0rem !important;)').a, ['style', '--h: 0rem !important;']);
});

test('カンマ区切りの選択子は 1 つずつのプログラムにし、最後の操作は全体に掛ける', () => {
  const { programs } = parseProcedural('.a:has-text(x), .b, .c:upward(1):remove()');
  assert.deepEqual(programs.map((p) => p.c), ['.a', '.b', '.c']);
  assert.ok(programs.every((p) => p.a?.[0] === 'rm'));
  // 括弧・引用符の中のカンマでは分けない
  assert.equal(splitTop('a:is(b, c), d[x="1,2"]', ',').length, 2);
  assert.equal(parseProcedural('.a:has-text(x), .b:has-text(y'), null);
});

test(':others() は、その前のカンマ区切りの全体を「残す要素」にする', () => {
  assert.deepEqual(one('#a, #b, .c:others()'), { c: '#a, #b, .c', s: [['others']] });
  assert.equal(parseProcedural('#a:has-text(x), .c:others()'), null);
});

test('手続き型のフィルターを読む（##・#?#・例外・全サイト共通）', () => {
  const f = parseFilter('example.com#?#.wrapper:has-text(Get Reward)');
  assert.equal(f.kind, 'cosmetic');
  assert.equal(f.procedural, true);
  assert.equal(f.selector, '.wrapper:has-text(Get Reward)');
  assert.deepEqual(f.include, ['example.com']);
  assert.equal(parseFilter('example.com##.x:upward(2)').procedural, true);
  assert.equal(parseFilter('example.com#@?#.x:-abp-contains(a)').exception, true);
  // 全サイト共通の手続き型は使わない（ページ全体を調べることになる）が、例外は受け付ける
  assert.equal(parseFilter('##.ad:has-text(広告)'), null);
  assert.equal(parseFilter('#?#.ad:has-text(広告)'), null);
  assert.equal(parseFilter('#@#.ad:has-text(広告)').exception, true);
  // #?# でも、中が純粋な CSS なら ## と同じ（CSS として隠す）
  assert.equal(parseFilter('example.com#?#.a:has(.b)').procedural, undefined);
  assert.equal(parseFilter('example.com#?#.a:-abp-has(.b)').selector, '.a:has(.b)');
  // :remove() だけのものは、これまでどおり CSS で隠す
  assert.equal(parseFilter('example.com##.overlay:remove()').procedural, undefined);
  // 全部で 1 つも手続き型を含まない列は null
  assert.equal(parseFilter('example.com##.a:has-text(x'), null);
});

test('手続き型は CosmeticEngine がホストごとに選び、例外とエンティティを守る', () => {
  const { cosmetic } = compileFilterList(
    [
      'example.com##.wrapper:has-text(Get Reward)',
      'example.com,~news.example.com##.box:upward(2)',
      'news.example.com#@#.wrapper:has-text(Get Reward)',
      'shop.*##.promo:contains(SALE):remove()',
      'foo.*,~foo.co.uk##.x:has-text(y)',
      '##.ignored:has-text(z)',
    ].join('\n'),
  );
  assert.deepEqual(Object.keys(cosmetic.procedural).sort(), ['example.com', 'foo.*', 'shop.*']);
  const engine = new CosmeticEngine([cosmetic]);
  const cs = (host) => engine.proceduralFor(host).map((p) => p.c).sort();
  assert.deepEqual(cs('example.com'), ['.box', '.wrapper']);
  assert.deepEqual(cs('www.example.com'), ['.box', '.wrapper']);
  assert.deepEqual(cs('news.example.com'), []); // 例外（#@#）と除外（~）
  assert.deepEqual(cs('other.org'), []);
  // エンティティ: shop.* は shop.com・shop.co.jp・www.shop.de のどれにも当たる
  assert.deepEqual(cs('shop.com'), ['.promo']);
  assert.deepEqual(cs('shop.co.jp'), ['.promo']);
  assert.deepEqual(cs('www.shop.de'), ['.promo']);
  assert.deepEqual(cs('myshop.com'), []);
  assert.deepEqual(cs('shop.evil.com'), []); // shop の後ろがサフィックスでない
  // 除外側のエンティティ（~foo.co.uk）は範囲を広げない
  assert.deepEqual(cs('foo.de'), ['.x']);
  assert.deepEqual(cs('foo.co.uk'), []);
});

test('通常の要素隠しでも example.* を使える（除外側も）', () => {
  const { cosmetic } = compileFilterList('site.*##.ad\nsite.*,~a.site.com##.b\nx.com,~y.*##.c');
  const engine = new CosmeticEngine([cosmetic]);
  assert.match(engine.pageCss('site.fr'), /\.ad\{/);
  assert.match(engine.pageCss('www.site.co.jp'), /\.ad\{/);
  assert.doesNotMatch(engine.pageCss('a.site.com'), /\.b\{/);
  assert.match(engine.pageCss('b.site.com'), /\.b\{/);
  assert.match(engine.pageCss('x.com'), /\.c\{/);
});

test('entityChain は公開サフィックスの手前を鍵にする', () => {
  assert.deepEqual(entityChain('example.com'), ['example.*']);
  assert.deepEqual(entityChain('www.example.com'), ['www.example.*', 'example.*']);
  assert.deepEqual(entityChain('example.co.jp'), ['example.*']);
  assert.deepEqual(entityChain('a.b.example.com.au'), ['a.b.example.*', 'b.example.*', 'example.*']);
  assert.deepEqual(entityChain('example.ne.jp'), ['example.*']);
  assert.deepEqual(entityChain('www.example.xyz'), ['www.example.*', 'example.*']); // ENTITY_TLDS にない TLD でもよい
  // 限界: 2 ラベルのサフィックスのうち上の規則にないものは 1 ラベルとして扱う
  assert.deepEqual(entityChain('example.asso.fr'), ['example.asso.*', 'asso.*']);
  // IP・ラベルが 1 つ・TLD でないもの
  for (const host of ['', 'localhost', '127.0.0.1', '[::1]', '192.0.2.1:80']) assert.deepEqual(entityChain(host), [], host);
});
