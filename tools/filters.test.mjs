// lib/filters.js と lib/cosmetic.js のテスト。  node --test "tools/*.test.mjs"

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CosmeticEngine } from '../lib/cosmetic.js';
import {
  ALLOW_ID_BASE,
  PRIORITY,
  SCRIPTLETS,
  compileFilterList,
  findBadfilters,
  isUsableSelector,
  REGEX_COST_LIMIT,
  parseFilter,
  regexCost,
} from '../lib/filters.js';
import { ENTITY_TLDS, MAX_ENTITY_DOMAINS } from '../lib/entity-tlds.js';
import { hostChain, isListed, normalizeDomain, siteKey } from '../lib/hosts.js';
import { RESOURCE_FILES } from '../lib/resources.js';

const root = new URL('../', import.meta.url);
const lines = (...list) => list.join('\n');

test('ドメインだけのフィルターは requestDomains にまとめる', () => {
  const { rules } = compileFilterList('||ads.example.com^\n||tracker.example.net^\n||sub.ads.example.com^');
  assert.equal(rules.length, 1);
  assert.deepEqual(rules[0].condition, { requestDomains: ['ads.example.com', 'tracker.example.net'] });
  assert.equal(rules[0].action.type, 'block');
});

test('オプションを declarativeNetRequest の条件にする', () => {
  const f = parseFilter('||example.com/ads/$script,image,third-party,domain=a.com|~b.a.com');
  assert.equal(f.kind, 'network');
  assert.equal(f.host, null);
  assert.equal(f.urlFilter, '||example.com/ads/');
  assert.deepEqual(f.condition, {
    domainType: 'thirdParty',
    initiatorDomains: ['a.com'],
    excludedInitiatorDomains: ['b.a.com'],
    resourceTypes: ['script', 'image'],
  });
});

test('否定の種類は excludedResourceTypes になる', () => {
  const f = parseFilter('/banner/ad-$~image');
  assert.deepEqual(f.condition, { excludedResourceTypes: ['image'] });
});

test('例外と important の優先度・ID', () => {
  const { rules } = compileFilterList('@@||cdn.example.com/ads.js\n||example.com/x$important\n/adframe.');
  const allow = rules.find((r) => r.action.type === 'allow');
  const important = rules.find((r) => r.condition.urlFilter === '||example.com/x');
  assert.equal(allow.priority, PRIORITY.allow);
  assert.ok(allow.id >= ALLOW_ID_BASE);
  assert.equal(important.priority, PRIORITY.important);
  assert.ok(important.id < ALLOW_ID_BASE);
});

test('再現できないフィルターは捨てる', () => {
  for (const line of [
    '||example.com^$popup',
    '||example.com^$redirect=no-such-resource',
    '||example.com^$redirect-rule=noopjs',
    '@@||example.com^$redirect=noopjs',
    '@@||example.com^$csp', // 値なしの例外
    '||example.com^$csp=', // 値なし
    '||example.com^$domain=~example.*', // 除外側のエンティティ
    '||example.com^$denyallow=example.*',
    'example.com##+js(trusted-set-constant, x, 1)',
    '##+js(set-constant, x, 1)', // 全サイト共通のスクリプレット
    'youtube.com##+js(set-constant, x, 1)',
    '##body:style(overflow: auto)', // 全サイト共通の :style()
    'example.com##body:style(background: url(https://evil.example/x.png))',
    'example.com##body:style(color: red} a{color: blue)',
    // 手続き型（:has-text など）は使えるようになった（tools/procedural.test.mjs）。再現できないものだけ捨てる
    'example.com##.ad:-abp-properties(*data:image*)',
    'example.com##.ad:matches-property(a)',
    'example.com#?#.ad:has-text(/(a+)+$/)', // ReDoS になりうる正規表現
    '##.ad:has-text(広告)', // 全サイト共通の手続き型
    'example.com#$#body { overflow: auto }',
    'example.com#%#//scriptlet("abort-on-property-read", "x")',
    '||例え.jp^',
    'ad',
  ]) {
    assert.equal(parseFilter(line), null, line);
  }
});

test('CSS を壊す選択子は使わない', () => {
  assert.ok(isUsableSelector('div[class^="ad-"] > a'));
  assert.ok(isUsableSelector('img[alt="広告"]'));
  assert.ok(!isUsableSelector('a[href="x'));
  assert.ok(!isUsableSelector('div{color:red}'));
  assert.ok(!isUsableSelector('div /* x'));
  assert.ok(!isUsableSelector('div:not(.a'));
});

test('要素隠しの分類', () => {
  const { cosmetic } = compileFilterList(
    lines(
      '##.ad-box',
      '###top-ad',
      '##div[id^="ad_"]',
      'example.com,~shop.example.com##.side-banner',
      'news.example.com#@#.ad-box',
      '~safe.example.org##.promo',
      '##.unwanted',
      '#@#.unwanted',
      '@@||broken.example.net^$generichide',
      '@@||plain.example.net^$elemhide',
    ),
  );
  assert.deepEqual(cosmetic.classes, ['ad-box', 'promo']);
  assert.deepEqual(cosmetic.ids, ['top-ad']);
  assert.deepEqual(cosmetic.complex, ['div[id^="ad_"]']);
  assert.deepEqual(cosmetic.specific, { 'example.com': ['.side-banner'] });
  assert.deepEqual(cosmetic.exceptions, {
    'news.example.com': ['.ad-box'],
    'safe.example.org': ['.promo'],
    'shop.example.com': ['.side-banner'],
  });
  assert.deepEqual(cosmetic.genericHide, ['broken.example.net']);
  assert.deepEqual(cosmetic.elemHide, ['plain.example.net']);
});

test('要素隠しの example.* は、実行時にホスト名と照らし合わせるので、そのまま持つ（除外側も）', () => {
  // 以前は捨てていたが、エンティティは lib/hosts.js の entityChain で判定する（tools/procedural.test.mjs）
  assert.deepEqual(parseFilter('a.com,b.*##.ad').include, ['a.com', 'b.*']);
  assert.deepEqual(parseFilter('b.*##.ad').include, ['b.*']);
  assert.deepEqual(parseFilter('a.com,~b.*##.ad').exclude, ['b.*']);
  // 通信ルールでは b.* を TLD の一覧に展開する（network-options の節のテスト）
  assert.ok(parseFilter('||x.example^$domain=a.com|b.*').condition.initiatorDomains.includes('b.com'));
  assert.equal(parseFilter('||x.example^$denyallow=a.com|b.*,domain=c.com'), null);
});

test('CosmeticEngine はサイトごとの例外を守る', () => {
  const { cosmetic } = compileFilterList(
    lines('##.ad-box', '##div[id^="ad_"]', 'example.com##.side-banner', 'news.example.com#@#.ad-box', '@@||quiet.example.com^$generichide'),
  );
  const engine = new CosmeticEngine([cosmetic]);

  const page = engine.pageCss('www.example.com');
  assert.match(page, /div\[id\^="ad_"\]\{display:none!important\}/);
  assert.match(page, /\.side-banner\{display:none!important\}/);
  assert.equal(engine.tokenCss('www.example.com', ['ad-box', 'other'], []), '.ad-box{display:none!important}');

  assert.equal(engine.tokenCss('news.example.com', ['ad-box'], []), '');
  assert.equal(engine.pageCss('quiet.example.com'), '.side-banner{display:none!important}');
  assert.equal(engine.usesTokens('quiet.example.com'), false);
  assert.doesNotMatch(engine.pageCss('other.org'), /side-banner/);
});

test(':style() と :remove()', () => {
  const style = parseFilter('example.com##.adsbox:style(display: block !important;)');
  assert.equal(style.selector, '.adsbox');
  assert.equal(style.style, 'display: block !important;');
  assert.equal(parseFilter('example.com##.overlay:remove()').selector, '.overlay');

  const { cosmetic } = compileFilterList(
    lines(
      'example.com##.adsbox:style(display: block !important;)',
      'example.com##body:style(overflow: auto !important)',
      'news.example.com#@#body:style(overflow: auto !important)',
      '##.adsbox',
    ),
  );
  assert.deepEqual(cosmetic.styles, {
    'example.com': ['.adsbox:style(display: block !important;)', 'body:style(overflow: auto !important)'],
  });
  const engine = new CosmeticEngine([cosmetic]);
  const css = engine.pageCss('www.example.com');
  assert.match(css, /\.adsbox\{display: block !important;\}/);
  assert.match(css, /body\{overflow: auto !important\}/);
  assert.doesNotMatch(engine.pageCss('news.example.com'), /overflow/);
  // :style() で見せている選択子は、後から届く class の隠すルールで上書きしない
  assert.equal(engine.tokenCss('www.example.com', ['adsbox'], []), '');
  assert.equal(engine.tokenCss('other.example.org', ['adsbox'], []), '.adsbox{display:none!important}');
});

test('$redirect は偽物への差し替えルールになり、ブロックより強く例外より弱い', () => {
  const { rules } = compileFilterList(
    lines(
      '||googlesyndication.com^',
      '||pagead2.googlesyndication.com/pagead/js/adsbygoogle.js$script,redirect=googlesyndication_adsbygoogle.js:5',
      '@@||pagead2.googlesyndication.com/pagead/js/adsbygoogle.js$domain=allowed.example',
    ),
  );
  const redirect = rules.find((r) => r.action.type === 'redirect');
  assert.deepEqual(redirect.action.redirect, { extensionPath: '/resources/googlesyndication_adsbygoogle.js' });
  assert.deepEqual(redirect.condition.resourceTypes, ['script']);
  assert.ok(redirect.priority > PRIORITY.block);
  assert.ok(redirect.priority <= PRIORITY.allow); // 同じ優先度なら allow が勝つ
  assert.ok(redirect.id < ALLOW_ID_BASE);
});

test('$redirect の名前はすべて resources/ のファイルになる', () => {
  for (const file of RESOURCE_FILES) assert.ok(existsSync(new URL(`resources/${file}`, root)), file);
  assert.equal(parseFilter('/fuckadblock.$script,redirect=fuckadblock.js-3.2.0').redirect, '/resources/fuckadblock.js');
  assert.equal(parseFilter('||x.example^$image,redirect=1x1-transparent.gif').redirect, '/resources/1x1.gif');
});

test('$method は requestMethods になる', () => {
  const f = parseFilter('||example.com/ad$method=post|~get');
  assert.deepEqual(f.condition, { requestMethods: ['post'], excludedRequestMethods: ['get'] });
  assert.equal(parseFilter('||example.com/ad$method=brew'), null);
});

test('スクリプレットのフィルターを読む', () => {
  assert.deepEqual(parseFilter('example.com,~sub.example.com,example.*##+js(aopr, adsBlocked)'), {
    kind: 'scriptlet',
    exception: false,
    include: ['example.com', 'example.*'], // example.* はそのまま持つ
    exclude: ['sub.example.com'],
    name: 'abort-on-property-read',
    args: ['adsBlocked'],
  });
  // 引用符・エスケープしたカンマ・.js の付いた名前
  assert.deepEqual(parseFilter("a.com##+js(rmnt.js, script, '/adblock, detected/', stay, 1)").args, [
    'script',
    '/adblock, detected/',
    'stay',
    '1',
  ]);
  assert.deepEqual(parseFilter('a.com##+js(nostif, a\\,b, 1000)').args, ['a,b', '1000']);
  // YouTube 以外のサイトだけ残す
  assert.deepEqual(parseFilter('youtube.com,b.com##+js(set, x, true)').include, ['b.com']);
  // 例外
  assert.equal(parseFilter('a.com#@#+js(set, x, true)').exception, true);
  assert.deepEqual(parseFilter('a.com#@#+js()'), {
    kind: 'scriptlet',
    exception: true,
    include: ['a.com'],
    exclude: [],
    name: '',
    args: [],
  });
  // ~example.* のような除外も持つ（捨てると範囲が広がるため）
  assert.deepEqual(parseFilter('a.com,~b.*##+js(set, x, true)').exclude, ['b.*']);
});

test('スクリプレットの名前は content/scriptlets.js にすべてある', () => {
  const source = readFileSync(new URL('content/scriptlets.js', root), 'utf8');
  const table = source.slice(source.indexOf('const scriptlets = {'));
  for (const name of Object.keys(SCRIPTLETS)) {
    assert.ok(table.includes(`'${name}':`) || table.includes(`\n    ${name}:`), name);
  }
});

test('スクリプレットはサイトごとに番号で持ち、例外も集める', () => {
  const { scriptlets, stats } = compileFilterList(
    lines(
      'a.com,b.com##+js(set, x, true)',
      'c.com##+js(set-constant, x, true)',
      '~sub.a.com,a.com##+js(nowoif)',
      'b.com#@#+js(set, x, true)',
      'd.com#@#+js()',
    ),
  );
  assert.equal(stats.scriptlet, 5);
  const json = scriptlets.toJSON();
  assert.deepEqual(json.entries, [['set-constant', 'x', 'true'], ['no-window-open-if']]);
  assert.deepEqual(json.add, { 'a.com': [0, 1], 'b.com': [0], 'c.com': [0] });
  assert.deepEqual(json.remove, { 'b.com': [0], 'd.com': [-1], 'sub.a.com': [1] });
  assert.deepEqual(scriptlets.hosts, ['a.com', 'b.com', 'c.com']);
});

test('!#if はこの拡張機能（Chromium の MV3）に合う側だけを読む', () => {
  const { cosmetic } = compileFilterList(
    lines(
      '!#if env_chromium',
      'a.com##.chromium',
      '!#else',
      'a.com##.not-chromium',
      '!#endif',
      '!#if cap_html_filtering',
      'a.com##.html-filtering',
      '!#else',
      '!#if (ext_ubol && !env_firefox) || env_safari',
      'a.com##.ubol',
      '!#endif',
      '!#endif',
      'a.com##.always',
    ),
  );
  assert.deepEqual(cosmetic.specific, { 'a.com': ['.chromium', '.ubol', '.always'] });
});

test('$badfilter で別のフィルターを打ち消す', () => {
  const badfilters = new Set(findBadfilters('||ads.example.com^$third-party,badfilter\n||x.example^'));
  assert.deepEqual([...badfilters], ['||ads.example.com^$third-party']);
  const { rules, stats } = compileFilterList('||ads.example.com^$third-party\n||other.example^$third-party', { badfilters });
  assert.equal(stats.network, 1);
  assert.deepEqual(rules[0].condition.requestDomains, ['other.example']);
});

test('ホスト名の関数', () => {
  assert.deepEqual(hostChain('a.b.example.com'), ['a.b.example.com', 'b.example.com', 'example.com', 'com']);
  assert.equal(siteKey('www.example.com'), 'example.com');
  assert.ok(isListed(['example.com'], 'news.example.com'));
  assert.ok(!isListed(['example.com'], 'example.com.evil.net'));
  assert.equal(normalizeDomain(' https://WWW.Example.com/path?q=1 '), 'www.example.com');
  assert.equal(normalizeDomain('*.example.com'), 'example.com');
  assert.equal(normalizeDomain('例え.jp'), 'xn--r8jz45g.jp');
  assert.equal(normalizeDomain('not a domain'), '');
});

const PRIME_DOMAINS = ['www.amazon.co.jp', 'www.amazon.co.uk', 'www.amazon.com', 'www.amazon.de', 'www.primevideo.com'];

test('$removeparam=名前 は、クエリーからパラメーターを消す redirect ルールになる', () => {
  const { rules } = compileFilterList(
    '/GetPlaybackResources?$xhr,removeparam=deviceAdInsertionTypeOverride,domain=' + PRIME_DOMAINS.join('|'),
  );
  assert.deepEqual(rules, [
    {
      id: 1,
      priority: PRIORITY.redirect,
      action: {
        type: 'redirect',
        redirect: { transform: { queryTransform: { removeParams: ['deviceAdInsertionTypeOverride'] } } },
      },
      condition: {
        initiatorDomains: PRIME_DOMAINS,
        resourceTypes: ['xmlhttprequest'],
        urlFilter: '/GetPlaybackResources?',
        isUrlFilterCaseSensitive: false,
      },
    },
  ]);
});

test('$removeparam は種類の指定がなければ main_frame・sub_frame・xmlhttprequest で、ドメインのまとめには入らない', () => {
  const { rules } = compileFilterList('||example.com^$removeparam=ad.prof\n||example.net^$removeparam=caid,important');
  assert.equal(rules.length, 2);
  assert.deepEqual(rules[0].condition, {
    urlFilter: '||example.com^',
    isUrlFilterCaseSensitive: false,
    resourceTypes: ['main_frame', 'sub_frame', 'xmlhttprequest'],
  });
  assert.equal(rules[1].priority, PRIORITY.important);
  assert.deepEqual(rules[1].action.redirect.transform.queryTransform.removeParams, ['caid']);
});

test('正規表現 + uritransform=//置き換え/ は regexSubstitution の redirect ルールになる', () => {
  const { rules, stats } = compileFilterList(
    String.raw`/(.*\/GetPlaybackResources\?.*)%2CCuepointPlaylist(.*)/$xhr,uritransform=//$1$2/,domain=` + PRIME_DOMAINS.join('|'),
  );
  assert.equal(stats.skipped, 0);
  assert.deepEqual(rules, [
    {
      id: 1,
      priority: PRIORITY.redirect,
      action: { type: 'redirect', redirect: { regexSubstitution: String.raw`\1\2` } },
      condition: {
        initiatorDomains: PRIME_DOMAINS,
        resourceTypes: ['xmlhttprequest'],
        regexFilter: String.raw`(.*\/GetPlaybackResources\?.*)%2CCuepointPlaylist(.*)`,
        isUrlFilterCaseSensitive: false,
      },
    },
  ]);
});

test('!#if ext_ubol の側にある Prime Video の 2 行が使われる', () => {
  const { rules } = compileFilterList(
    lines(
      '!#if ext_ubol',
      '/GetPlaybackResources?$xhr,removeparam=deviceAdInsertionTypeOverride,domain=www.primevideo.com',
      String.raw`/(.*\/GetPlaybackResources\?.*)%2CCuepointPlaylist(.*)/$xhr,uritransform=//$1$2/,domain=www.primevideo.com`,
      '!#else',
      '/GetPlaybackResources?$xhr,removeparam=other,domain=www.primevideo.com',
      '!#endif',
    ),
  );
  assert.equal(rules.length, 2);
  assert.deepEqual(rules[0].action.redirect.transform.queryTransform.removeParams, ['deviceAdInsertionTypeOverride']);
  assert.equal(rules[1].action.redirect.regexSubstitution, String.raw`\1\2`);
});

test('$removeparam・uritransform のうち再現できないものは使わない', () => {
  for (const line of [
    '||example.com^$removeparam', // 全部消す
    '||example.com^$removeparam=/^utm_/', // 正規表現
    '||example.com^$removeparam=/utm_/i',
    '||example.com^$~removeparam=a',
    '@@||example.com^$removeparam=a',
    '||example.com^$removeparam=a,redirect=noopjs',
    '||idnes.cz/_servix/media/video.aspx$script,uritransform=/reklama=1/reklama=0/', // 正規表現でないパターン
    String.raw`/(?=a)(b)(.*)/$xhr,uritransform=//$1$2/`, // 先読み
    String.raw`/(?<!a)(b)/$xhr,uritransform=//$1/`, // 後読み
    String.raw`/(a)\1(.*)/$xhr,uritransform=//$1$2/`, // 後方参照
    '/(a)(.*)é/$xhr,uritransform=//$1$2/', // ASCII 以外
    '/(a)(.*)/$xhr,uritransform=//$1$3/', // 捕捉グループが足りない
    '/(a)(.*)/$xhr,uritransform=//$1$$2/', // 置き換えの $ は $1〜$9 だけ
    String.raw`/(a)(.*)/$xhr,uritransform=//$1\2/`,
    '@@/(a)(.*)/$xhr,uritransform=//$1$2/',
    '/(a)(.*)/$xhr,uritransform=//$1$2/,redirect=noopjs',
  ]) {
    assert.equal(parseFilter(line), null, line);
  }
});

// ---- 通信ルールの書き方（$document・$csp・正規表現・example.*・to=）----

test('domain=・from= の example.* は TLD の一覧に展開する', () => {
  const f = parseFilter('*$script,3p,domain=linkshorts.*|a.com,denyallow=google.com|gstatic.com');
  const d = f.condition.initiatorDomains;
  assert.ok(d.includes('linkshorts.com') && d.includes('linkshorts.co.jp') && d.includes('a.com'));
  assert.ok(d.length > 50 && d.length <= MAX_ENTITY_DOMAINS);
  assert.deepEqual(f.condition.excludedRequestDomains, ['google.com', 'gstatic.com']);
  assert.deepEqual(
    parseFilter('||x.example^$from=a.*').condition.initiatorDomains,
    ENTITY_TLDS.map((t) => `a.${t}`),
  );
  // 展開の上限を超えるものは使わない
  const many = Array.from({ length: 20 }, (_, i) => `site${i}.*`).join('|');
  assert.equal(parseFilter(`||x.example^$domain=${many}`), null);
  // 要素隠しの example.* は展開せず、そのまま持つ（実行時に判定する）
  assert.deepEqual(parseFilter('b.*##.ad').include, ['b.*']);
});

test('to= は requestDomains・excludedRequestDomains になり、TLD だけの指定も使える', () => {
  assert.deepEqual(parseFilter('*$script,to=a.com|~b.a.com').condition, {
    resourceTypes: ['script'],
    requestDomains: ['a.com'],
    excludedRequestDomains: ['b.a.com'],
  });
  assert.deepEqual(parseFilter('||x.example^$to=agency|art|asia').condition.requestDomains, ['agency', 'art', 'asia']);
  assert.deepEqual(parseFilter('*$script,from=dutchycorp.net,to=~sentry-cdn.com').condition, {
    resourceTypes: ['script'],
    initiatorDomains: ['dutchycorp.net'],
    excludedRequestDomains: ['sentry-cdn.com'],
  });
  assert.ok(parseFilter('*$script,to=x.*').condition.requestDomains.includes('x.co.jp'));
  // to=~com と denyallow= は両方の除外を持つ
  assert.deepEqual(
    parseFilter('*$script,3p,to=~com,denyallow=a.net,domain=b.com').condition.excludedRequestDomains,
    ['com', 'a.net'],
  );
});

test('$match-case は大文字小文字を区別する。正規表現のフィルターも変換する', () => {
  const { rules } = compileFilterList(
    lines(
      '/Banner$image,match-case',
      String.raw`/\/uploads\/2025\/\d{2}\/[0-9a-z]{6,12}\.jpg$/$image,match-case,1p,domain=igg-games.co|igg-games.com`,
      String.raw`/^https?:\/\/(?:www\.)?[-0-9a-z]{5,}\.(com|org)\/ad\.js/$script,3p`,
    ),
  );
  const plain = rules.find((r) => r.condition.urlFilter === '/Banner');
  assert.equal(plain.condition.isUrlFilterCaseSensitive, true);
  const cs = rules.find((r) => r.condition.regexFilter?.startsWith(String.raw`\/uploads`));
  assert.equal(cs.condition.isUrlFilterCaseSensitive, true);
  assert.deepEqual(cs.condition.resourceTypes, ['image']);
  assert.equal(cs.condition.domainType, 'firstParty');
  assert.equal(cs.action.type, 'block');
  const ci = rules.find((r) => r.condition.regexFilter?.startsWith('^https?'));
  assert.equal(ci.condition.isUrlFilterCaseSensitive, false);
  assert.ok(!('urlFilter' in ci.condition));
});

test('RE2 に入らない正規表現・大きすぎる正規表現は使わない', () => {
  for (const line of [
    '/a(?=b)c/$script',
    String.raw`/(a)\1c/$script`,
    '/ad.{100,}/',
    String.raw`/Add/$script`,
    '/ab/$script', // 短すぎる
  ]) {
    assert.equal(parseFilter(line), null, line);
  }
  assert.ok(parseFilter('/ads[0-9]+/'));
});

test('正規表現ルールは、リストごとの上限を超えたぶんを使わない', () => {
  const text = Array.from({ length: 5 }, (_, i) => `/ads${i}[0-9]+x/`).join('\n');
  const { rules, stats } = compileFilterList(text, { maxRegexRules: 3 });
  assert.equal(rules.length, 3);
  assert.equal(stats.skipped, 2);
});

test('||host^$document はページ（main_frame）のブロックで、ドメインはまとめる', () => {
  const { rules } = compileFilterList(lines('||ads.example^$document', '||b.example^$doc', '||c.example^$document,domain=x.com'));
  assert.equal(rules.length, 2);
  const bundled = rules.find((r) => r.condition.requestDomains.length === 2);
  assert.deepEqual(bundled.condition, { requestDomains: ['ads.example', 'b.example'], resourceTypes: ['main_frame'] });
  assert.equal(bundled.action.type, 'block');
  // 文字列のパターンは、ある程度長いものだけ
  assert.equal(parseFilter('.com/smartpop/$document').condition.resourceTypes[0], 'main_frame');
  assert.equal(parseFilter('/ads/*$document'), null);
  assert.equal(parseFilter('*$document'), null);
  // 種類と組み合わせたときは両方
  assert.deepEqual(parseFilter('||ads.example^$document,subdocument').condition.resourceTypes, ['sub_frame', 'main_frame']);
  assert.deepEqual(parseFilter('/webtracking/*$~document,~subdocument').condition.excludedResourceTypes, [
    'main_frame',
    'sub_frame',
  ]);
});

test('@@...$document は allowAllRequests（main_frame・sub_frame）になる', () => {
  const { rules } = compileFilterList(lines('@@||ok.example^$document', '@@||ok2.example^$document', '@@||p.example/login$document'));
  assert.ok(rules.every((r) => r.action.type === 'allowAllRequests' && r.id >= ALLOW_ID_BASE && r.priority === PRIORITY.allow));
  assert.equal(rules.length, 2);
  assert.deepEqual(rules[0].condition.resourceTypes, ['main_frame', 'sub_frame']);
  assert.deepEqual(rules.find((r) => r.condition.requestDomains).condition.requestDomains, ['ok.example', 'ok2.example']);
  assert.equal(parseFilter('@@||ok.example^$document,script'), null);
  assert.equal(parseFilter('@@||ok.example^$document,subdocument').allowAll, true);
  assert.equal(parseFilter('@@||ok.example^$document,domain=a.com'), null); // initiator は 1 つ前のページになる
});

test('$csp は応答の Content-Security-Policy を append する modifyHeaders になる', () => {
  const { rules } = compileFilterList(
    lines(
      "||thegay.example^$csp=default-src 'self' *.ahcdn.com",
      "||feet9.example^$csp=worker-src 'none';",
      "||ads.example/x/$csp=script-src 'none',subdocument",
      '@@||google.com/recaptcha/$csp,subdocument', // 値なしの例外は使わない
    ),
  );
  assert.equal(rules.length, 3);
  const frame = rules.find((r) => r.condition.urlFilter === '||ads.example/x/');
  assert.deepEqual(frame.action, {
    type: 'modifyHeaders',
    responseHeaders: [{ header: 'content-security-policy', operation: 'append', value: "script-src 'none'" }],
  });
  assert.deepEqual(frame.condition.resourceTypes, ['sub_frame']);
  assert.ok(frame.id < ALLOW_ID_BASE && frame.priority === PRIORITY.block);
  const host = rules.find((r) => r.condition.requestDomains?.includes('thegay.example'));
  assert.deepEqual(host.condition.resourceTypes, ['main_frame', 'sub_frame']);
  assert.equal(host.action.responseHeaders[0].value, "default-src 'self' *.ahcdn.com");
  // 範囲を絞らないもの・別の種類との組み合わせ・値なしは使わない
  assert.equal(parseFilter('*$csp=script-src'), null);
  assert.equal(parseFilter('||x.example^$csp=a,script'), null);
  assert.equal(parseFilter('||x.example^$csp'), null);
});

test('$csp,domain=X の X は、リンク元（initiator）ではなくリクエスト先（requestDomains）にする', () => {
  // X を直接開く main_frame には initiator が無いので、initiatorDomains のままだと CSP が付かない（実機で確認）
  const { rules } = compileFilterList(
    lines("||filecrypt.example^$csp=script-src 'none',domain=filecrypt.example|filecrypt.test", "*$csp=script-src 'none',domain=a.example|~b.a.example,1p"),
  );
  const first = rules.find((r) => r.condition.urlFilter === '||filecrypt.example^');
  assert.deepEqual(first.condition.requestDomains, ['filecrypt.example', 'filecrypt.test']);
  assert.equal(first.condition.initiatorDomains, undefined);
  const second = rules.find((r) => r.condition.requestDomains?.includes('a.example') && !r.condition.urlFilter);
  assert.deepEqual(second.condition.excludedRequestDomains, ['b.a.example']);
  assert.equal(second.condition.excludedInitiatorDomains, undefined);
  assert.equal(second.condition.domainType, undefined); // 1p（リンク元と同じサイト）の判定は要らない
});

test('$redirect の名前の後ろの :数字（uBlock Origin の優先度）は取り除く', () => {
  assert.equal(parseFilter('||x.example/a.mp4$media,redirect=noop-1s.mp4:10').redirect, '/resources/noop-1s.mp4');
  assert.equal(parseFilter('||x.example/ima3.js$script,redirect=google-ima.js:5').redirect, '/resources/google-ima.js');
  assert.equal(parseFilter('||x.example/b.js$script,redirect=nobab2.js:10').redirect, '/resources/nobab2.js');
});

// ---- 手続き型・エンティティ（変換結果の形）----

test('cosmetic.json の procedural は、ホスト名 → 選択子（文字のまま）で、例外・全サイト共通の例外も持つ', () => {
  const { cosmetic, stats } = compileFilterList(
    lines(
      'a.com,b.com#?#.w:has-text(Get Reward)',
      'a.com##.u:upward(2)',
      'shop.*##.p:contains(SALE):remove()',
      'b.com#@#.w:has-text(Get Reward)',
      '#@#.u:upward(2)',
      '##.generic:has-text(x)', // 全サイト共通は使わない
      'a.com##.plain',
    ),
  );
  // b.com の分は残り、例外（#@#）で実行時に外れる。全サイト共通の例外（#@#.u:upward(2)）に当たる a.com の .u は入らない
  assert.deepEqual(cosmetic.procedural, {
    'a.com': ['.w:has-text(Get Reward)'],
    'b.com': ['.w:has-text(Get Reward)'],
    'shop.*': ['.p:contains(SALE):remove()'],
  });
  assert.deepEqual(cosmetic.exceptions, { 'b.com': ['.w:has-text(Get Reward)'] });
  assert.deepEqual(cosmetic.specific, { 'a.com': ['.plain'] });
  assert.equal(stats.skipped, 1);
  // 変換結果は JSON にできる（rules/<id>.cosmetic.json に書く形）
  assert.deepEqual(JSON.parse(JSON.stringify(cosmetic)).procedural, cosmetic.procedural);
});

test('スクリプレットの example.* は鍵のまま持ち、除外側（~example.*）も remove に入れる', () => {
  const { scriptlets } = compileFilterList(
    lines('2embed.*,a.com##+js(set-attr, iframe, src, [data-src])', 'x.com,~y.*##+js(nowoif)', 'z.*#@#+js(nowoif)'),
  );
  const json = scriptlets.toJSON();
  assert.deepEqual(json.add, { '2embed.*': [0], 'a.com': [0], 'x.com': [1] });
  assert.deepEqual(json.remove, { 'y.*': [1], 'z.*': [1] });
  assert.deepEqual(scriptlets.hosts, ['2embed.*', 'a.com', 'x.com']);
});

test('追加したスクリプレットの名前と別名を読む', () => {
  assert.equal(parseFilter('a.com##+js(cookie-remover, x)').name, 'remove-cookie');
  assert.equal(parseFilter('a.com##+js(norafif, foo)').name, 'prevent-requestAnimationFrame');
  assert.equal(parseFilter('a.com##+js(href-sanitizer, a[href], ?url)').args.length, 2);
  assert.equal(parseFilter('a.com##+js(json-prune-xhr-response, ads, , propsToMatch, /api)').name, 'json-prune-xhr-response');
  assert.equal(parseFilter('a.com##+js(disable-newtab-links)').name, 'disable-newtab-links');
  assert.equal(parseFilter('a.com##+js(set-attr, img, src, [data-src])').name, 'set-attr');
  // YouTube 以外でも使えない名前は捨てる
  assert.equal(parseFilter('a.com##+js(trusted-replace-xhr-response, x)'), null);
});

test(':style() の宣言に --custom-property を使える', () => {
  assert.equal(parseFilter('a.com##[data-x] ~ *:style(--global-nav-ad-height: 0rem !important;)').style, '--global-nav-ad-height: 0rem !important;');
});

// 実機（Chrome 157）に rules/*.json を読み込ませた結果。[ルール ID, regexFilter, 大文字小文字を区別するか, memoryLimitExceeded で拒否されたか]
const CHROME_REGEX_RESULTS = [
  ["easylist#1279", "(https?:\\/\\/)\\w{30,}\\.me\\/\\w{30,}\\.", false, true],
  ["easylist#2564", "^https?:\\/\\/.*\\.(club|bid|biz|xyz|site|pro|info|online|icu|monster|buzz|website|biz|re|casa|top|one|space|network|live|systems|ml|world|life|co)\\/.*", false, true],
  ["easylist#2565", "\\/[0-9a-f]{32}\\/invoke\\.js", false, false],
  ["easylist#2591", "^https?:\\/\\/www\\.[0-9a-z]{8,}\\.com\\/[0-9a-z]{1,4}\\.js$", false, false],
  ["easylist#2592", "\\.gsmarena\\.com\\/[0-9]+\\.[a-z]+\\?s?Search=", false, false],
  ["easylist#3137", "^https?:\\/\\/.*\\.(club|news|live|online|store|tech|guru|cloud|bid|xyz|site|pro|info|online|icu|monster|buzz|fun|website|photos|re|casa|top|today|space|network|live|work|systems|ml|world|life)\\/.*", false, true],
  ["easylist#3138", "^https?:\\/\\/.*\\/.*sw[0-9._].*", false, false],
  ["easylist#3139", "^https?:\\/\\/.*\\/[a-z0-9A-Z_]{2,15}\\.(php|jx|jsx|1ph|jsf|jz|jsm|j$)", false, true],
  ["japanese#284", "\\.com\\/(?:[a-z]{2,}-)+p-\\d{4,6}\\.html\\?(?:page_source|prevRef|re[fl])=", true, false],
  ["japanese#334", "^https?:\\/\\/(?:j[ap]|qq)\\d{4,8}\\.[a-z]{6,8}\\.[a-z]{2,10}\\/", true, false],
  ["japanese#367", "^https?:\\/\\/(?:[-0-9a-z]{3,}\\.)?[a-z]{5,}\\.[a-z]{3,7}\\/product\\/\\d{4,7}(\\.html)?$", false, false],
  ["japanese#368", "^https?:\\/\\/(?:[-0-9a-z]{4,}\\.)?[a-z]{5,}\\.org\\/product\\/\\d{4,7}(\\.html)?$", false, false],
  ["japanese#369", "^https:\\/\\/[a-z]{5,8}\\.[a-z]{4,10}\\.[a-z]{2,6}\\/item\\/m\\d{10,11}$", false, false],
  ["japanese#375", "\\.(?:club|cn|icu|top|pro|site|work)\\/Personal\\/member\\/Login\\/index\\.php\\?oneTimeAccessID=", false, false],
  ["japanese#376", "^https:\\/\\/[-0-9a-z]{6,20}\\.com\\/item-[0-9A-Za-z]{10}\\.html$", true, true],
  ["japanese#871", "\\/js\\/(?:anime|comic|doujin|game)Ranking", false, false],
  ["japanese#975", "\\/pc(?:max)?728(?:200)?[a-z]?\\.png$", false, false],
  ["japanese#1003", "\\/bv\\.php\\?no=2(?:6[79]|7[37]|9[12])$", false, false],
  ["japanese#1161", "\\/shinbun\\/[0-9a-z]{3,12}200(280)?\\.(?:jpg|png)$", false, false],
  ["japanese#1162", "\\/bnr_side_(kiso3|octopass)\\.jpg", false, false],
  ["japanese#1256", "\\/right\\/(?:[a-z]+([a-z_]+\\d{2})?|[0-9a-z_-]*(?:bnr|banner)[0-9a-z-_]*)\\.(?:gif|jpg|png)$", false, false],
  ["japanese#1299", "dcms_media\\/image\\/(?:bownow|[%_0-9A-Z]{30,})\\.(?:png|jpg)$", true, true],
  ["japanese#1492", "^https?:\\/\\/[0-9a-z-]{5,12}\\.duckdns", false, false],
  ["ubo#77", "(?:com|net)\\/[a-z-]{3,10}\\.html$", false, false],
  ["ubo#78", "(?:com|net)\\/[0-9a-f]{12}\\.js$", false, false],
  ["ubo#500037", "^https:\\/\\/[a-z]\\.pussyspace\\.(com|net)\\/xv7\\/[0-9a-f]+-([0-9a-f]+-){3}[0-9a-f]{12}\\/\\d\\/xv_\\d{1,2}_t\\.jpg$", false, false],
  ["ubo#500038", "^https:\\/\\/[a-z]\\.pussyspace\\.(com|net)\\/(yip?|xvs)\\/videos\\/20\\d{4}\\/\\d{2}\\/\\d+\\/(original|thumbs_\\d{2})\\/\\d{0,2}(\\(m=e[0-9A-Za-z]+(aaaa)?\\)\\(mh=[-_0-9A-Za-z]+\\))?\\d{0,2}\\.jpg$", false, false],
  ["ubo#500039", "^https:\\/\\/[a-z]\\.pussyspace\\.(com|net)\\/(yip?|xvs)\\/videos\\/thumbs169l\\/[0-9a-f]{2}\\/[0-9a-f]{2}\\/[0-9a-f]{2}\\/[0-9a-f]+(-\\d)?\\/[0-9a-f]+\\.\\d{1,2}\\.jpg$", false, false],
  ["ubo#500040", "^https:\\/\\/[a-z]\\.pussyspace\\.(com|net)\\/(yip?|xvs)\\/videos\\/thumbs_5\\/\\d{1,2}(\\(m=e[0-9A-Za-z]{5,7}aaaa\\)\\(mh=[-_0-9A-Za-z]+\\))?\\.jpg$", false, false],
  ["ubo#500041", "^https:\\/\\/[a-z]\\.pussyspace\\.(com|net)\\/[a-z]?jz\\/([0-9a-f]\\/){3,5}[0-9a-f]+-?(\\d{1,3}|((\\d{3,4}-){3}h264)?\\.(mp4-\\d{1,2}|flv-\\d))\\.jpg$", false, false],
  ["ubo#500042", "^https:\\/\\/[a-z]\\.pussyspace\\.(com|net)\\/sb\\/t\\/\\d+\\/(\\d|[0-9a-f]{2})\\/(\\d|[0-9a-f]{2})\\/w:300\\/t\\d{1,2}-enh\\/([0-9a-z]+-)*[0-9a-z]+\\.jpg$", false, false],
  ["ubo#500043", "^https:\\/\\/www\\.pussyspace\\.(com|net)\\/upload\\/cat\\.image\\/[_3a-z]{2,}\\.jpg$", false, false],
  ["ubo#500044", "^https:\\/\\/www\\.pussyspace\\.(com|net)\\/upload\\/poster_img_url\\/par\\/c3Rhci9[%0-9A-Za-z]+&size_width\\/par\\/160\\/l\\.jpg$", false, false],
  ["ubo#269", "\\/uploads\\/2025/\\d{2}\\/[0-9a-z]{6,12}\\.jpg$", true, false],
  ["ubo#544", "\\.com\\/[_0-9a-zA-Z]+\\.jpg$", false, false],
  ["ubo#722", "postsImgs", false, false],
  ["ubo#736", "devfiles.pages.dev\\/img\\/[a-zA-Z0-9]{8,}.jpeg", false, false],
  ["ubo#755", "^https:\\/\\/[a-z-]+\\.cdn-[a-z]\\.net\\/$", false, false],
  ["ubo#756", "^https:\\/\\/\\d+\\.cfd\\/[a-z]{3}tag[a-z]{3}\\/v\\d\\/[a-zA-Z0-9]+:C\\d\\.js\\b", true, false],
  ["ubo#761", "^https?:\\/\\/(?:www\\.|[0-9a-z]{7,10}\\.)?[-0-9a-z]{5,}\\.(?:com|org)\\/\\/?(?:[0-9a-z]{2}\\/){2,3}[0-9a-f]{32}\\.js", false, true],
  ["ubo#762", "^https?:\\/\\/(?:www\\.|pl\\d+\\.)?[-0-9a-z]{5,}\\.(com|org)\\/(?:[0-9a-f]{2}\\/){3}[0-9a-f]+\\.js", true, false],
  ["ubo#763", "^https:\\/\\/[-0-9a-z]{4,}\\.(com|org)\\/\\d{1,2}\\/[0-9a-f]{23,}$", true, false],
  ["ubo#764", "\\/[0-9a-z]{2}\\/[0-9a-f]{32}\\.js", true, false],
  ["ubo#765", "\\/[0-9a-z]{2}\\/[0-9a-f]{32}\\.js", true, false],
  ["ubo#766", "\\/[0-9a-f]{32}\\.js", false, false],
  ["ubo#767", "\\.\\d{1,2}\\.[0-9a-f]{32}\\.js$", true, false],
  ["ubo#772", "\\/t\\/[0-9]{3}\\/[0-9]{3}\\/a[0-9]{4,9}\\.js$", false, false],
  ["ubo#773", "\\.cloudfront\\.net\\/\\?[a-z]{3,5}=\\d{6,7}$", true, false],
  ["ubo#774", "^https:\\/\\/[0-9a-f]{10}\\.[0-9a-f]{10}\\.com\\/[0-9a-f]{32}\\.js$", true, true],
  ["ubo#775", "^https:\\/\\/[0-9a-f]{10}\\.[0-9a-f]{10}\\.com\\/.*\\.js$", true, false],
  ["ubo#776", "^https:\\/\\/[0-9a-f]{10}\\.[0-9a-f]{10}\\.com\\/[0-9a-f]{32}\\/\\d{6}\\b", true, true],
  ["ubo#779", "^https?:\\/\\/s3\\.us-east-1\\.amazonaws\\.com\\/[0-9a-f]+\\/[0-9a-f]{10}$", true, false],
  ["ubo#780", "^https?:\\/\\/[a-z]{8,15}\\.top(\\/(?:\\d{1,5}|0NaN|articles?|browse|index|movie|news|pages?|static|view|web|wiki)){1,4}(?:\\.html|\\/)$", true, true],
  ["ubo#781", "^https?:\\/\\/[a-z]{8,15}\\.top\\/[-a-z]{4,}\\.css\\?aHR0c[\\/0-9a-zA-Z]{33,}=?=?$", true, true],
  ["ubo#782", "^https?:\\/\\/[a-z]{8,15}\\.top\\/[a-z]{4,}\\.png\\?aHR0c[\\/0-9a-zA-Z]{33,}=?=?$", true, true],
  ["ubo#783", "^https?:\\/\\/[a-z]{8,15}\\.xyz(\\/(?:\\d{1,5}|0NaN|articles?|browse|index|movie|news|pages?|static|view|web|wiki)){1,4}(?:\\.html|\\/)$", true, true],
  ["ubo#784", "^https?:\\/\\/[a-z]{8,15}\\.xyz\\/[-a-z]{4,}\\.css\\?aHR0c[\\/0-9a-zA-Z]{33,}=?=?$", true, true],
  ["ubo#785", "^https?:\\/\\/[a-z]{8,15}\\.xyz\\/[a-z]{4,}\\.png\\?aHR0c[\\/0-9a-zA-Z]{33,}=?=?$", true, true],
  ["ubo#788", "^https?:\\/\\/[-a-z]{6,}\\.(?:com?|info|pro|xyz)\\/[a-d][-.\\/A-Z_a-z][DHWXm][-.\\/A-Z_a-z][59FVZ][-.\\/A-Z_a-z][6swyz][-.\\/A-Z_a-z][-\\/0-9A-Z_a-z][-.\\/A-Z_a-z][-\\/0-9A-Z_a-z]+(?:$|\\?)", true, false],
  ["ubo#789", "^https?:\\/\\/[-a-z]{6,}\\.com\\/b[\\/A-Z_a-z]3[.A-Za-z]V[.\\/A-Z_a-z]0[.\\/A-Z_a-z]P[.A-Za-z]3[-\\/0-9A-Z_a-z]{7,}$", true, false],
  ["ubo#790", "\\/[a-d][-.\\/A-Z_a-z][DHWXm][-.\\/A-Z_a-z][59FVZ][-.\\/A-Z_a-z][6swyz][-.\\/A-Z_a-z][-\\/0-9A-Z_a-z][-.\\/A-Z_a-z][-\\/0-9A-Z_a-z]+", true, false],
  ["ubo#795", "\\.goplay\\.su\\/[a-z][0-9A-Za-z]{10,}\\/\\d{3,6}$", true, false],
  ["ubo#796", "^https:\\/\\/([a-z]{2}|[a-z]{5,7})\\.[a-z]{7,14}\\.com\\/[rt][0-9A-Za-z]{10,16}\\/[A-Za-z]{4,5}(?:\\?|$)", true, false],
  ["ubo#797", "^https:\\/\\/[a-z]{2}\\.[a-z]{6,14}\\.shop\\/i[0-9A-Za-z]{10,16}\\/[A-Za-z]{4,5}\\b", true, false],
  ["ubo#798", "^https:\\/\\/[0-9a-z]*\\.?[0-9a-z]+\\.cfd\\/[a-z][0-9A-Za-z]{10,22}\\/(\\d{6}|[A-Za-z]{5})$", true, false],
  ["ubo#799", "^https:\\/\\/[0-9a-z]*\\.?[0-9a-z]+\\.rest\\/[a-z][0-9A-Za-z]{10,22}\\/(\\d{6}|[A-Za-z]{5})$", true, false],
  ["ubo#821", "\\.[a-z]{2,6}\\/[0-9a-zA-Z]{5,8}\\.js$", true, false],
  ["ubo#822", "^https?:\\/\\/a\\.[-0-9a-z]{4,}\\.[a-z]{2,5}\\/[0-9a-zA-Z]{5,8}\\.js$", true, false],
  ["ubo#823", "^https?:\\/\\/asg\\.[-0-9a-z]{4,}\\.[a-z]{2,5}\\/[0-9a-zA-Z]{5,8}\\.js$", true, false],
  ["ubo#824", "^https?:\\/\\/emsi\\.[-0-9a-z]{4,}\\.[a-z]{2,5}\\/[0-9a-zA-Z]{5,8}\\.js$", true, false],
  ["ubo#826", "^https:\\/\\/[0-9a-z]{3,15}\\.biz\\/\\?[a-z]e=[0-9a-z]{22,26}$", true, true],
  ["ubo#827", "^https?:\\/\\/cdn\\.[a-z]{3,8}\\.[a-z]{2,6}\\/app\\.js$", true, false],
  ["ubo#846", "^https?:\\/\\/.*\\/easylist\\/[0-9]{5}", false, false],
  ["ubo#849", "\\.[a-z]{3,5}\\/[0-9a-z]{8,12}\\/[0-9a-z]{8,12}\\.js$", false, false],
  ["ubo#876", "^https:\\/\\/www\\.[a-z]{8,16}\\.com\\/(?:[A-Za-z]+\\/)*(?:[_0-9A-Za-z]{1,20}[-.])*[_0-9A-Za-z]{1,20}\\.js$", true, true],
  ["ubo#894", "\\/static\\/js\\/jav\\.[a-f0-9]{12}\\.js$", true, false],
  ["ubo#950", "^https:\\/\\/supervideo\\.cc/[0-9]+\\.js\\b", false, false],
  ["ubo#957", "^https?:\\/\\/[a-z0-9]{5,15}\\.[a-z]{2,3}\\/5\\/\\d{6,7}(?:\\?_=\\d+|\\/\\??)?$", false, false],
  ["ubo#958", "^https?:\\/\\/[-0-9a-z]{5,15}\\.(?:com|net)\\/400\\/\\d{7,8}(?:\\?v=\\d+)?$", false, true],
  ["ubo#959", "^https?:\\/\\/[-0-9a-z]{5,15}\\.(?:com|net)\\/401\\/\\d{7,8}(?:\\?v=\\d+)?$", false, true],
  ["ubo#960", "^https?:\\/\\/[-a-z]{8,15}\\.(?:com|net)\\/500\\/\\d{7}\\?", false, false],
  ["ubo#961", "^https?:\\/\\/[a-z0-9]{5,15}\\.com\\/vignette\\.min\\.js$", true, false],
  ["ubo#962", "^https?:\\/\\/[a-z0-9]{5,15}\\.(?:com|net)\\/tag\\.min\\.js$", true, false],
  ["ubo#964", "^https?:\\/\\/[a-z]{8,15}\\.com\\/$", false, false],
  ["ubo#965", "^https?:\\/\\/[a-z]{8,15}\\.net\\/$", false, false],
  ["ubo#966", "^https?:\\/\\/[a-z]{8,15}\\.xyz\\/$", false, false],
  ["ubo#976", "^https:\\/\\/[a-z]{8,12}\\.com\\/en\\/(?:[a-z]{2,10}\\/){0,2}[a-z]{2,}\\?(?:[a-z]+=[^&=?\\s]*?&)*?id=[12]\\d{6}\\b", true, false],
  ["ubo#977", "^https:\\/\\/www\\.gayxnow\\.com\\/[a-z][a-z][a-z][a-z][a-z][a-z]?\\.js$", false, false],
  ["ubo#978", "^https:\\/\\/[a-z]{7}\\.com\\/\\d{7}\\.js$", false, false],
  ["ubo#986", "^https:\\/\\/strumyk\\.net\\/assets\\/[0-9]+.js$", true, false],
  ["ubo#987", "\\/z-[a-z0-9]{7,10}(\\.js)?$", false, false],
  ["ubo#988", "^https?:\\/\\/[a-z]{4,}\\.top\\/z-[a-z0-9]{7,10}$", true, false],
  ["ubo#989", "\\/z-\\d{8}\\.js$", true, false],
  ["ubo#994", "\\.[a-z]{2,}\\/[a-f0-9]{32}\\.js\\?_=17\\d+$", true, false],
  ["ubo#995", "\\/js\\/[a-z0-9]+\\.js$", true, false],
  ["ubo#996", "^https:\\/\\/www\\.locopelis\\.com\\/[a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9]\\.js$", true, false],
  ["ubo#998", "^https:\\/\\/[a-z]{3,5}\\.[a-z]{10,14}\\.top\\/[a-z]{10,16}\\/[a-z]{5,6}(?:\\?d=\\d)?$", true, false],
  ["ubo#1005", "^https:\\/\\/[a-z]+\\.[a-z]+\\/embed\\/[a-f0-9]{32}\\.js\\?_=\\d+$", true, true],
  ["ubo#1027", "\\/wp-content\\/plugins\\/[a-f]{6}\\.js\\?ver=", true, false],
  ["ubo#1028", "\\/wp-content\\/uploads(?:\\/[a-f]{6}){2}\\.js", true, false],
  ["ubo#1029", "^https:\\/\\/[-a-z0-9]+\\.[a-z]+\\/uploads(?:\\/[a-f]{6}){2}\\.js\\?ver=17\\d{8}$", true, false],
  ["ubo#1030", "\\.com\\/[0-9a-f]{9}\\.js\\?ver=", true, false],
  ["ubo#1056", "^https:\\/\\/[a-z]{3,}\\.[a-z]{7,}\\.[a-z]{2,4}\\/[^\\/]{2,}\\/[-_a-zA-Z0-9]{5,10}\\.js$", true, false],
  ["ubo#1057", "^https:\\/\\/[a-z]{3,}\\.[a-z]{7,}\\.[a-z]{2,4}\\/[^\\/]{2,}\\/[-_a-zA-Z0-9]{5,10}\\.js$", true, false],
  ["ubo#1059", "^https:\\/\\/[a-z]{3,}\\.[a-z]{7,}\\.[a-z]{2,4}\\/[^\\/]{2,}\\/[-_a-zA-Z0-9]{5,10}\\.js$", true, false],
  ["ubo#1060", "^https:\\/\\/([a-z]{3,}\\.)?[a-z]{7,}\\.[a-z]{2,4}\\/[^\\/]{2,}\\/[-_a-zA-Z0-9]{11,}\\.js$", true, false],
  ["ubo#1068", "^https:\\/\\/([a-z]{3,}\\.)?[a-z]{7,}\\.[a-z]{2,4}\\/[^\\/]{2,}\\/[-_a-zA-Z0-9]{11,}\\.js$", true, false],
  ["ubo#1069", "^https:\\/\\/[a-z]{3,}\\.[a-z]{7,}\\.[a-z]{2,4}\\/[^\\/]{2,}\\/[-_a-zA-Z0-9]{5,10}\\.js$", true, false],
  ["ubo#1089", "\\/[0-9a-z]{2}\\/[0-9a-f]{32}\\.js", true, false],
  ["ubo#1115", "\\.liveonlinesports\\.net/[a-z0-9]{35}\\.js$", false, true],
  ["ubo#1118", "^https:\\/\\/filmizip\\.com\\/templates\\/filmizip\\/js\\/[a-z0-9]{16}\\.js\\?v=", true, false],
  ["ubo#1119", "^https:\\/\\/filmizip\\.com\\/templates\\/filmizip\\/js\\/[a-z0-9]{12}\\.min\\.js\\?v=", true, false],
  ["ubo#1218", "^https:\\/\\/[a-z0-9]{6,10}\\.[a-z]{2,3}\\/js\\d?\\/noadblocker\\.js(?:\\?v=\\d)?$", true, false],
  ["ubo#1233", "^https:\\/\\/([a-z]+\\.)?sythe\\.org\\/[\\w\\W]{30,}", false, false],
  ["ubo#1301", "^https:\\/\\/(?:cdn77\\.)?aj[0-9a-z]{2}\\d{2}\\.online\\/[0-9a-z]{8}\\.js$", false, false],
  ["ubo#1302", "^https:\\/\\/(?:cdn77\\.)?aj[0-9a-z]{2}\\d{2}\\.bid\\/[0-9a-z]{8}\\.js$", false, false],
  ["ubo#1351", "xxx\\/(?:[a-z]+[_-]){1,2}[a-z]+\\.(?:gif|jpg)$", false, false],
  ["ubo#1355", "\\.com\\/(full)?ad[0-9a-z]+\\.(?:gif|jpg)$", false, false],
  ["ubo#1383", "^https:\\/\\/[0-9a-z]{8,}\\.[a-z0-9]{7,}\\.[a-z]{4,}\\/[0-9a-f]{32}\\/a4\\/[0-9a-f]{13}\\.js$", true, true],
  ["ubo#1384", "^https:\\/\\/[0-9a-z]{8,}\\.[a-z0-9]{7,}\\.[a-z]{4,}\\/[0-9a-f]{32}\\/b4\\/[0-9a-f]{13}\\.js$", true, true],
  ["ubo#500396", "^https:\\/\\/ads\\.host-cdn\\.net\\/\\w+\\.js\\?\\w+$", false, false],
  ["ubo#1590", "\\/aot-content\\/modules\\/[^\\.]{40,}\\.js\\b", false, true],
  ["ubo#1598", "\\.com\\/[A-Za-z]{9,}\\/[A-Za-z]{9,}\\.js$", false, false],
  ["ubo#1609", "demonoid\\.is\\/[a-z0-9]{24}\\.jpg$", true, false],
  ["ubo#1662", "^https?:\\/\\/[a-z]{6,12}\\.com\\/script\\/n[a-z]su\\.js$", false, false],
  ["ubo#1774", "\\.com\\/[0-9a-z]{12,}\\/[0-9a-z]{12,}\\.js$", false, false],
  ["ubo#1803", "^https?:\\/\\/[-0-9a-z]{5,}\\.com\\/[0-9a-z]{8,10}\\?key=[0-9a-f]{32}$", false, true],
  ["ubo#1806", "^https:\\/\\/distrowatch\\.com\\/images\\/[a-z]+\\/[a-z]+$", false, false],
  ["ubo#1813", "^https:\\/\\/[a-z]{8}\\.xyz\\/main\\.js$", false, false],
  ["ubo#1876", "\\/static\\/[0-9a-z]+/[0-9a-z]+\\.js$", false, false],
  ["ubo#1954", "\\beropics\\.to\\/[a-zA-Z0-9]{8}\\.js$", false, false],
  ["ubo#1987", "\\/assets\\/jquery\\/jquery-\\d\\.\\d\\.(?:\\d\\.)?min\\.js\\?(?:v=2)?&?type=(?:adult|mainstream)$", false, false],
  ["ubo#1994", "\\/js\\/\\d{2,3}eka\\d{2,3}\\.js$", false, false],
  ["ubo#2110", "^https:\\/\\/zefoy\\.com\\/[^\\/]+\\?", false, false],
  ["ubo#2114", "^https:\\/\\/[0-9]+\\.b-cdn\\.net\\/w\\.js$", true, false],
  ["ubo#2169", "\\/js\\/[a-z]j\\.js$", false, false],
  ["ubo#2197", "\\/common\\/images\\/[a-z0-9]{1,5}\\-[a-z0-9]{1,5}\\.png$", true, false],
  ["ubo#2245", "\\.cloudfront\\.net\\/[a-z]{9,12}\\.js$", true, false],
  ["ubo#2302", "^https:\\/\\/bbs\\.[a-z0-9-]*xh[a-z0-9-]*\\.[cd][eo][ms]i?\\/[a-zA-Z0-9-][a-zA-Z0-9-][a-zA-Z0-9-][a-zA-Z0-9-][a-zA-Z0-9-]$", false, false],
  ["ubo#2376", "nyaa\\.land\\/static\\/[a-z0-9]{32}\\.jpg$", false, true],
  ["ubo#2379", "^https:\\/\\/www\\.thesun\\.co\\.uk\\/[0-9a-z]{32}\\.js$", true, false],
  ["ubo#2381", "theme/002/js/application.js?2.0|$script,1p,replace=/video\\.maxPop/0", false, false],
  ["ubo#2523", "\\bgamatotv\\.info\\/[a-z0-9]{32}\\.js\\b", false, true],
  ["ubo#2598", "\\/[A-Z]{1,2}\\/[-0-9a-z]{5,}\\.com\\/(?:[0-9a-f]{2}\\/){3}[0-9a-f]{32}\\.js$", true, true],
  ["ubo#2618", "\\.com\\/\\d+/[0-9a-z]+\\.js$", false, false],
  ["ubo#2644", "(.*\\/GetPlaybackResources\\?.*)%2CCuepointPlaylist(.*)", false, false],
  ["ubo#2646", "^https:\\/\\/cdn77\\.pornoxo\\.com\\/pxo\\/www\\/js-v[.0-9]+\\/[a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9]\\.min\\.js", true, false],
  ["ubo#2666", "^https:\\/\\/hunterscomics\\.com\\/wp-content\\/themes(\\/[a-f]{6}){2}\\.js\\?ver=", false, false],
  ["ubo#2686", "\\/js\\/script_[0-9][0-9]\\.[0-9][0-9]\\.js\\?[0-9]+$", true, false],
  ["ubo#2710", "^https:\\/\\/souq-design\\.com\\/wp-content\\/uploads(?:\\/[a-f]{6}){2}.js\\?ver=", false, false],
  ["ubo#2719", "^https:\\/\\/netembed\\.xyz\\/[a-f0-9]{32}\\.js\\b", false, false],
  ["ubo#2728", "_static/delivery.js?nonce=$script,1p,header=server:/^openresty\\/", false, false],
  ["ubo#2739", "\\/[0-9a-f]{32}\\.js", false, false],
  ["ubo#2740", "\\/[0-9a-f]{32}\\.js", false, false],
  ["ubo#2766", "\\/js\\/(?:[a-z]+\\/)?[a-z]+_[a-f0-9]{32}\\.js\\b", true, false],
  ["ubo#2787", "\\.gsmarena\\.com\\/[0-9]+\\.php3", false, false],
  ["ubo#2788", "\\.gsmarena\\.com\\/[0-9]+\\.[a-z]+\\?s?Search=", false, false],
  ["ubo#2856", "^https:\\/\\/smallencode\\.me\\/[a-zA-Z0-9]+\\/[0-9]+\\.js$", false, false],
  ["ubo#2892", "\\/?h=[a-f0-9]{32}&z=\\d+$", false, false],
  ["ubo#2898", "\\/[0-9a-f]{12}\\.js$", false, false],
  ["ubo#2974", "\\/wp-content\\/themes\\/[a-z]+\\/assets\\/js\\/fun\\.js\\?ver=[0-9]\\.[0-9]\\.[0-9]$", true, false],
  ["ubo#2980", "^https:\\/\\/mewcdn\\.online\\/[a-f0-9]{32}\\.js\\?", false, false],
  ["ubo#2985", "^https:\\/\\/[a-z]{32,}\\.pages\\.dev\\/[a-z]{32,}\\.js\\b", false, false],
  ["ubo#2994", "^https:\\/\\/[a-z0-9-]{7,}\\.[a-z]{3,6}\\/assets\\/script$", true, false],
  ["ubo#2995", "^https:\\/\\/[a-z0-9-]{7,}\\.[a-z]{3,6}\\/challenge\\/(?:movie|show|episode)\\/[\\/a-z0-9-]+$", true, false],
  ["ubo#2996", "^https:\\/\\/[a-z0-9-]{7,}\\.[a-z]{3,6}\\/(?:load|register)\\/(?:movie|show|episode)\\/[0-9]+(?:\\/[0-9]{1,2}){0,2}\\/?\\?[a-z]+=[a-zA-Z0-9%&]+(?:&[a-z]+=[0-9a-z]+)?$", true, true],
  ["ubo#3021", "^https:\\/\\/nekostream\\.site\\/[a-f0-9]{32}\\.js(?:$|\\?)", false, false],
  ["ubo#3027", "^https:\\/\\/engine\\.[a-z]+\\.[a-z]+\\/\\?[0-9]+$", false, false],
  ["ubo#3068", "^https:\\/\\/streamhls\\.to\\/[a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9][a-z0-9]\\.js$", true, false],
  ["ubo#3075", "^https?:\\/\\/[-a-z]{6,}\\.(?:com?|info|pro|xyz)\\/[a-d][-.\\/A-Z_a-z][DHWXm][-.\\/A-Z_a-z][59FVZ][-.\\/A-Z_a-z][6swyz][-.\\/A-Z_a-z][-\\/0-9A-Z_a-z][-.\\/A-Z_a-z][-\\/0-9A-Z_a-z]+$", true, false],
  ["ubo#500702", "^https:\\/\\/www\\.igorslab\\.de\\/wp-content\\/themes\\/igor\\/js\\/jquery-\\d\\.\\d{1,2}\\.\\d{1,2}\\.min\\.js\\?ver=", true, false],
  ["easyprivacy#5107", "^https:\\/\\/cdn\\.jsdelivr\\.net\\/npm\\/[-a-z_]{4,22}@latest\\/dist\\/script\\.min\\.js$", false, true],
  ["easyprivacy#7190", "^https?:\\/\\/fdts\\.ebay-kleinanzeigen\\.de\\/[a-z0-9]{13,18}\\.js\\?", false, false],
  ["easyprivacy#7191", "^https?:\\/\\/pov\\.spectrum\\.net\\/[a-zA-Z0-9]{14,}\\.js", false, false],
  ["easyprivacy#7192", "^https?:\\/\\/tjmaxx\\.tjx\\.com\\/libraries\\/[a-z0-9]{20,}", false, false],
  ["easyprivacy#7193", "^https?:\\/\\/tmx\\.(td|tdbank)\\.com\\/[a-z0-9]{14,18}\\.js.*", false, false],
  ["easyprivacy#7194", "^https?:\\/\\/www\\.ebay-kleinanzeigen\\.de\\/[a-z0-9]{8}\\-[0-9a-f]{4}\\-", false, false],
  ["easyprivacy#7195", "^https?:\\/\\/www\\.kroger\\.com\\/content\\/{20,}", false, false],
];

test('regexCost: 実機で拒否された 30 件はすべて上限を超え、受理された 148 件はほとんどが上限以内に収まる', () => {
  assert.equal(CHROME_REGEX_RESULTS.length, 178);
  const rejected = CHROME_REGEX_RESULTS.filter((r) => r[3]);
  const accepted = CHROME_REGEX_RESULTS.filter((r) => !r[3]);
  assert.equal(rejected.length, 30);
  for (const [id, re, cs] of rejected) assert.ok(regexCost(re, cs) > REGEX_COST_LIMIT, `${id} ${re}`);
  // 受理されたものを誤って除外するのは、安全側に倒した分だけ（実測は 16 件）
  const lost = accepted.filter(([, re, cs]) => regexCost(re, cs) > REGEX_COST_LIMIT);
  assert.ok(lost.length <= 16, `受理されたものを除外 ${lost.length} 件`);
  // 受理された最大（上限以内のもの）と拒否された最小の間に上限がある
  const maxKept = Math.max(...accepted.map(([, re, cs]) => regexCost(re, cs)).filter((c) => c <= REGEX_COST_LIMIT));
  const minRejected = Math.min(...rejected.map(([, re, cs]) => regexCost(re, cs)));
  assert.ok(maxKept <= REGEX_COST_LIMIT && REGEX_COST_LIMIT < minRejected, `${maxKept} ${REGEX_COST_LIMIT} ${minRejected}`);
});

test('正規表現のフィルターは、regexCost が上限を超えるものを使わない', () => {
  assert.equal(parseFilter(String.raw`/nyaa\.land\/static\/[a-z0-9]{32}\.jpg$/$image`), null);
  assert.equal(parseFilter(String.raw`/(https?:\/\/)\w{30,}\.me\/\w{30,}\./`), null);
  assert.ok(parseFilter(String.raw`/^https?:\/\/[a-z]{5,8}\.[a-z]{4,10}\.[a-z]{2,6}\/item\/m\d{10,11}$/`));
  // match-case かどうかで見積もりが変わる（大文字を小文字に寄せられない）
  assert.ok(regexCost('[a-zA-Z]{20}', true) > regexCost('[a-zA-Z]{20}', false));
});

test('/.../ の形でも、途中にオプション（|$script,... など）が入っているものは正規表現として使わない', () => {
  assert.equal(parseFilter(String.raw`/theme/002/js/application.js?2.0|$script,1p,replace=/video\.maxPop/0/`), null);
  assert.equal(parseFilter(String.raw`/_static/delivery.js?nonce=$script,1p,header=server:/^openresty\//`), null);
});

test('build-filters.mjs の LISTS と manifest のルールセットは、ID・順番・パスが同じ（新しいリストも含む）', () => {
  const source = readFileSync(new URL('./build-filters.mjs', import.meta.url), 'utf8');
  const body = /export const LISTS = \[([\s\S]*?)\n\];/.exec(source)[1];
  const listIds = [...body.matchAll(/\bid: '([a-z0-9]+)'/g)].map((m) => m[1]);
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  const rulesets = manifest.declarative_net_request.rule_resources;
  assert.deepEqual(rulesets.map((r) => r.id), listIds);
  assert.ok(new Set(listIds).size === listIds.length);
  for (const r of rulesets) assert.equal(r.path, `rules/${r.id}.json`);
  // 上限を超えたとき前から有効になるので、基本のリストが先、追加した 5 つは重要な順
  assert.deepEqual(listIds.slice(0, 6), ['base', 'easylist', 'japanese', 'ubo', 'easyprivacy', 'unbreak']);
  assert.deepEqual(listIds.slice(6), ['quickfixes', 'badware', 'peterlowe', 'privacy', 'adguarddns']);
});

test('AdGuard DNS フィルターのホスト名（||host^）をまとめても、base.txt の偽物への差し替えが負けない', () => {
  const base = readFileSync(new URL('../filters/base.txt', import.meta.url), 'utf8');
  const redirects = compileFilterList(base).rules.filter((r) => r.action.type === 'redirect' && r.condition.urlFilter);
  assert.ok(redirects.length >= 8);
  const dns = [
    'doubleclick.net',
    'googlesyndication.com',
    'google-analytics.com',
    'googletagmanager.com',
    'googletagservices.com',
    'amazon-adsystem.com',
    'scorecardresearch.com',
  ];
  const [block] = compileFilterList(dns.map((d) => `||${d}^`).join('\n')).rules;
  assert.deepEqual([...block.condition.requestDomains].sort(), [...dns].sort());
  assert.equal(block.priority, PRIORITY.block);
  for (const r of redirects) assert.ok(r.priority > block.priority && r.priority <= PRIORITY.allow, r.condition.urlFilter);
});

test('偽物への差し替え（$redirect）は、Peter Lowe のようなドメイン単位のブロックより強い優先度', () => {
  const [block] = compileFilterList('||googlesyndication.com^').rules;
  const [redirect] = compileFilterList('||pagead2.googlesyndication.com/pagead/js/adsbygoogle.js$script,redirect=googlesyndication_adsbygoogle.js').rules;
  assert.equal(block.priority, PRIORITY.block);
  assert.equal(redirect.action.type, 'redirect');
  assert.ok(redirect.priority > block.priority);
});
