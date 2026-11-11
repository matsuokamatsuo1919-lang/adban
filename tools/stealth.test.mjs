// 「広告ブロッカー検出に見つからない」ための確認。  node --test "tools/*.test.mjs"
// ・ページ側（MAIN world）の content/scriptlets.js が包んだ関数は、ページから見て元の関数と同じ toString・名前・長さになる
// ・XMLHttpRequest はクラスを差し替えず、プロトタイプのメソッドだけを包む（instanceof・prototype・descriptor が元のまま）
// ・ページに見える文字列（目印の属性・例外のメッセージ・要素の名前）に、拡張機能の名前を入れない
// 実ブラウザーでの「拡張機能あり・なし」の比較は tools/e2e/stealth-test.mjs で行う。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');

// 最低限の XMLHttpRequest もどき（ネイティブらしく、プロトタイプにメソッドとゲッターを持つ）
const MOCK = `
  var self = globalThis;
  self.addEventListener = () => {};
  var location = { hostname: 'example.com', href: 'https://example.com/' };
  class XMLHttpRequestEventTarget {
    constructor() { this._l = {}; }
    addEventListener(t, f) { (this._l[t] ||= []).push(f); }
    dispatchEvent(e) { for (const f of this._l[e.type] || []) f.call(this, e); return true; }
  }
  var XMLHttpRequest = class XMLHttpRequest extends XMLHttpRequestEventTarget {
    constructor() { super(); this._state = 0; this._text = ''; }
    open(method, url) { if (arguments.length < 2) throw new TypeError('2 arguments required'); this._url = url; this._state = 1; }
    send() { this._state = 4; this._text = '{"a":1,"ads":[1]}'; }
    get readyState() { return this._state; }
    get status() { return this._state === 4 ? 200 : 0; }
    get statusText() { return this._state === 4 ? 'OK' : ''; }
    get responseURL() { return this._url; }
    get responseText() { return this._text; }
    get response() { return this._text; }
    get responseXML() { return null; }
    get responseType() { return ''; }
    getResponseHeader() { return null; }
    getAllResponseHeaders() { return ''; }
  };
  XMLHttpRequest.DONE = 4;
  class Event { constructor(type) { this.type = type; } }
  class ProgressEvent extends Event {}
  function fetch() {}
  function eval2() {}
`;

const loadScriptlets = (entries) => {
  const context = vm.createContext({ setTimeout, clearTimeout, console });
  vm.runInContext(MOCK, context);
  vm.runInContext(`self.__adbanScriptlets = [${JSON.stringify({ entries, add: { 'example.com': entries.map((_, i) => i) }, remove: {} })}];`, context);
  vm.runInContext(read('content/scriptlets.js'), context, { filename: 'scriptlets.js' });
  return context;
};
const run = (context, code) => vm.runInContext(code, context);

test('包んだ関数の toString・name・length は元の関数と同じに見える', () => {
  const origin = loadScriptlets([]);
  const wrapped = loadScriptlets([
    ['prevent-fetch', '/never'],
    ['json-prune', 'ads'],
  ]);
  for (const code of ['self.fetch', 'JSON.parse']) {
    assert.equal(run(wrapped, `Function.prototype.toString.call(${code})`), run(origin, `Function.prototype.toString.call(${code})`), code);
    assert.equal(run(wrapped, `${code}.toString()`), run(origin, `${code}.toString()`), code);
    assert.equal(run(wrapped, `${code}.name`), run(origin, `${code}.name`), code);
    assert.equal(run(wrapped, `${code}.length`), run(origin, `${code}.length`), code);
  }
  // 実際に包まれている（包んでいないのに通ってしまうテストにしない）
  assert.notEqual(run(wrapped, 'self.fetch'), run(origin, 'self.fetch'));
  assert.match(run(wrapped, 'Function.prototype.toString.call(JSON.parse)'), /\[native code\]/);
});

test('Function.prototype.toString 自体も元と同じに見え、this が関数でないときは元と同じ TypeError', () => {
  const wrapped = loadScriptlets([['json-prune', 'ads']]);
  const nativeText = vm.runInNewContext('Function.prototype.toString.toString()');
  assert.equal(run(wrapped, 'Function.prototype.toString.toString()'), nativeText);
  assert.equal(run(wrapped, 'Function.prototype.toString.call(Function.prototype.toString)'), nativeText);
  assert.equal(run(wrapped, 'Function.prototype.toString.name'), 'toString');
  assert.equal(run(wrapped, 'Function.prototype.toString.length'), 0);
  for (const bad of ['{}', 'undefined', '1', 'null']) {
    const message = (ctx) => vm.runInContext(`try { Function.prototype.toString.call(${bad}); 'no throw' } catch (e) { e.constructor === TypeError ? e.message : 'other ' + e }`, ctx);
    assert.equal(message(wrapped), message(vm.createContext({})), bad);
  }
  // 包んでいない普通の関数・クラス・Proxy は今までどおり
  assert.equal(run(wrapped, 'Function.prototype.toString.call(function foo() { return 1; })'), 'function foo() { return 1; }');
  assert.equal(run(wrapped, 'Function.prototype.toString.call(class A {})'), 'class A {}');
});

test('二重に包まれた関数（setTimeout を 2 つの scriptlet が包む）も元の関数の見た目になる', () => {
  const context = vm.createContext({ setTimeout: function setTimeout() {}, console });
  vm.runInContext(MOCK, context);
  vm.runInContext(`self.__adbanScriptlets = [${JSON.stringify({ entries: [['prevent-setTimeout', 'x'], ['adjust-setTimeout', 'y']], add: { 'example.com': [0, 1] }, remove: {} })}];`, context);
  const before = vm.runInContext('Function.prototype.toString.call(self.setTimeout)', context);
  vm.runInContext(read('content/scriptlets.js'), context);
  assert.equal(vm.runInContext('Function.prototype.toString.call(self.setTimeout)', context), before);
  assert.equal(vm.runInContext('self.setTimeout.name', context), 'setTimeout');
});

test('XMLHttpRequest は差し替えず、プロトタイプのメソッド・ゲッターだけを包む（見た目が元のまま）', () => {
  const origin = loadScriptlets([]);
  const wrapped = loadScriptlets([
    ['prevent-xhr', '/never'],
    ['json-prune-xhr-response', 'ads', '', 'propsToMatch', '/ok.json'],
    ['xml-prune', 'Period', '', '.mpd'],
  ]);
  const describe = (ctx) =>
    run(
      ctx,
      `JSON.stringify({
        isOriginal: XMLHttpRequest === __origXhr,
        str: Function.prototype.toString.call(XMLHttpRequest),
        keys: Reflect.ownKeys(XMLHttpRequest).map(String),
        protoKeys: Reflect.ownKeys(XMLHttpRequest.prototype).map(String),
        instanceOf: new XMLHttpRequest() instanceof XMLHttpRequest,
        ctor: new XMLHttpRequest().constructor === XMLHttpRequest,
        superName: Object.getPrototypeOf(XMLHttpRequest).name,
        desc: ['open', 'send', 'responseText', 'response', 'readyState'].map((k) => {
          const d = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, k);
          const f = d.value || d.get;
          return [k, 'get' in d, d.enumerable, d.configurable, d.writable, f.name, f.length, Function.prototype.toString.call(f), f.toString()];
        }),
      })`,
    );
  for (const ctx of [origin, wrapped]) vm.runInContext('var __origXhr = XMLHttpRequest;', ctx);
  assert.deepEqual(JSON.parse(describe(wrapped)), JSON.parse(describe(origin)));
  // 引数が足りない open() は、ネイティブと同じく TypeError になる（クラスで継承して差し替えると、undefined を 2 つ渡してしまい投げなかった）
  assert.throws(() => run(wrapped, 'new XMLHttpRequest().open()'), { name: 'TypeError' });
});

test('XMLHttpRequest の応答の書き換えの挙動（json-prune-xhr-response・prevent-xhr）は今までどおり', () => {
  const wrapped = loadScriptlets([
    ['json-prune-xhr-response', 'ads', '', 'propsToMatch', '/ok.json'],
    ['prevent-xhr', '/blocked'],
  ]);
  // 対象の URL は書き換わり、対象でない URL はそのまま
  assert.equal(run(wrapped, `(() => { const x = new XMLHttpRequest(); x.open('GET', '/ok.json'); x.send(); return x.responseText + '|' + x.response; })()`), '{"a":1}|{"a":1}');
  assert.equal(run(wrapped, `(() => { const x = new XMLHttpRequest(); x.open('GET', '/other.json'); x.send(); return x.responseText; })()`), '{"a":1,"ads":[1]}');
  // prevent-xhr: 対象の通信は送られず、あとから偽の応答（空）で完了する
  return new Promise((resolve) => {
    run(wrapped, `globalThis.__log = []; const x = new XMLHttpRequest(); globalThis.__x = x;
      x.addEventListener('readystatechange', () => __log.push('rsc:' + x.readyState));
      x.addEventListener('load', () => __log.push('load:' + x.status + ':' + JSON.stringify(x.responseText)));
      x.open('GET', '/blocked'); __log.push('opened:' + x.readyState); x.send(); __log.push('sent:' + x.readyState);`);
    setTimeout(() => {
      assert.deepEqual(JSON.parse(run(wrapped, 'JSON.stringify(__log)')), ['opened:1', 'sent:1', 'rsc:4', 'load:200:""']);
      resolve();
    }, 50);
  });
});

test('ページに見える文字列に、拡張機能の名前（adban）を入れない', () => {
  // procedural.js の目印の属性: 乱数の名前（data-adban-mark ではない）
  const procedural = read('content/procedural.js');
  assert.doesNotMatch(procedural.match(/const MARK = .*$/m)[0], /adban/i);
  assert.match(procedural, /const MARK = `data-\$\{Math\.random\(\)/);
  // picker.js の要素の名前: 乱数のカスタム要素名
  const picker = read('content/picker.js');
  assert.doesNotMatch(picker, /createElement\(['`]adban/);
  assert.doesNotMatch(picker.match(/document\.createElement\(.*\);/)[0], /adban/i);
  // scriptlets.js: 例外のメッセージ・Trusted Types のポリシー名に使う文字列
  const scriptlets = read('content/scriptlets.js');
  assert.doesNotMatch(scriptlets.match(/const magic = .*$/m)[0], /adban/i);
  // 実行時に例外のメッセージに出るかを、vm の中で確かめる（abort-on-property-read の例外の message）
  const context = loadScriptlets([['abort-on-property-read', 'foo']]);
  assert.doesNotMatch(run(context, `try { globalThis.foo; 'no throw' } catch (e) { e.message }`), /adban/i);
});

test('CSS に入れる文字列（lib/cosmetic.js）に、拡張機能の名前やコメントがない', () => {
  const source = read('lib/cosmetic.js');
  // コードの中のコメントは問題ないが、insertCSS に渡す CSS の文字列には /* */ や adban を入れない
  const cssStrings = [...source.matchAll(/`([^`]*\{[^`]*\})`/g)].map((m) => m[1]);
  for (const css of cssStrings) assert.doesNotMatch(css, /adban|\/\*/i);
});
