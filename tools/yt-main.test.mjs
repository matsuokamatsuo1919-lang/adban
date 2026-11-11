// content/yt-main.js（YouTube のページ側で広告の情報を取り除く）のテスト。  node --test "tools/*.test.mjs"
// 包んだ JSON.parse / Response.prototype.json が、ページから見て元の関数と同じに見えること（広告ブロッカー検出の手がかりにならないこと）と、
// 広告の情報の除去が今までどおり動くことを確かめる。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../content/yt-main.js', import.meta.url), 'utf8');

// ページ側の環境の代わり。Response は json() を持つだけの簡単なもの
function makePage() {
  const context = vm.createContext({});
  vm.runInContext(
    'globalThis.window = globalThis; globalThis.Response = class Response { json() { return Promise.resolve({ adPlacements: [1], playerAds: [2], keep: 3 }); } };',
    context,
  );
  const run = (code) => vm.runInContext(code, context);
  return { context, run };
}

test('yt-main.js: 包んだ関数の toString が元の関数と同じに見える', () => {
  const { run } = makePage();
  const parseBefore = run('JSON.parse.toString()');
  const jsonBefore = run('Response.prototype.json.toString()');
  const toStringBefore = run('Function.prototype.toString.toString()');
  run(SOURCE);
  assert.equal(run('JSON.parse.toString()'), parseBefore);
  assert.equal(run('String(JSON.parse)'), parseBefore);
  assert.equal(run('Function.prototype.toString.call(JSON.parse)'), parseBefore);
  assert.equal(run('Response.prototype.json.toString()'), jsonBefore);
  assert.equal(run('Function.prototype.toString.call(Response.prototype.json)'), jsonBefore);
  assert.equal(run('Function.prototype.toString.toString()'), toStringBefore);
  assert.equal(run('JSON.parse.name'), 'parse');
  assert.equal(run('JSON.parse.length'), 2);
  // 関数でないものに対しては、元と同じ TypeError
  assert.throws(() => run('Function.prototype.toString.call({})'), /Function\.prototype\.toString requires that 'this' be a Function/);
});

test('yt-main.js: 広告の情報（adPlacements など）を JSON.parse と Response.json の結果から取り除く', async () => {
  const { run } = makePage();
  run(SOURCE);
  assert.equal(run(`JSON.stringify(JSON.parse('{"adPlacements":[1],"adSlots":[2],"x":3}'))`), '{"x":3}');
  assert.equal(run(`JSON.stringify(JSON.parse('{"playerResponse":{"playerAds":[1],"y":2}}'))`), '{"playerResponse":{"y":2}}');
  const text = await run('new Response().json().then((v) => JSON.stringify(v))');
  assert.equal(text, '{"keep":3}');
});

test('yt-main.js: ytInitialPlayerResponse に代入された広告の情報も取り除く', () => {
  const { run } = makePage();
  run(SOURCE);
  run('window.ytInitialPlayerResponse = { adPlacements: [1], title: "t" };');
  assert.equal(run('JSON.stringify(window.ytInitialPlayerResponse)'), '{"title":"t"}');
});
