// content/yt-main.js（YouTube のページ側で広告の情報を取り除く）のテスト。  node --test "tools/*.test.mjs"
// 1. JSON.parse / Response.prototype.json を改変しないこと。YouTube は広告のキーを含む偽のプレイヤー応答を作り、
//    JSON.parse・new Response(...).json()・data: URL の fetch の結果が元のままかを確かめて広告ブロッカーを検出している。
// 2. 実際の応答（Response.url が /youtubei/v1/）と ytInitialPlayerResponse からだけ、広告のキーを取り除くこと。
//    検出メッセージ（auxiliaryUi.messageRenderers）は取り除かない（サーバーが期待する値の一覧と食い違い、エラー画面になるため）。
// 3. 包んだ関数が、ページから見て元の関数と同じに見えること。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../content/yt-main.js', import.meta.url), 'utf8');

const PLAYER_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const MESSAGE = { bkaEnforcementMessageViewModel: { displayType: 'ENFORCEMENT_MESSAGE_VIEW_MODEL_DISPLAY_TYPE_PLAYER' }, enforcementMessageViewModel: { a: 1 }, keepMe: { b: 2 } };

// ページ側の環境の代わり。Response / Headers は Node のものをそのまま使い、fetch は next に積んだ応答を返す
function makePage() {
  const state = { next: null, calls: [] };
  const context = vm.createContext({
    Response,
    Headers,
    __record: (input, init) => {
      state.calls.push(JSON.stringify([input, init]));
      return Promise.resolve(state.next);
    },
  });
  // fetch は、本物と同じくページ側の実行環境の関数にする（Function.prototype.toString の差し替えが効く範囲にそろえる）
  vm.runInContext('globalThis.window = globalThis; globalThis.fetch = function fetch(input, init) { return __record(input, init); };', context);
  const run = (code) => vm.runInContext(code, context);
  // 応答を作って、次の fetch の結果にする。url は Response.url（実際の URL）
  const serve = (url, body, { status = 200, contentType = 'application/json; charset=UTF-8' } = {}) => {
    const response = new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': contentType } });
    Object.defineProperty(response, 'url', { value: url });
    state.next = response;
    return response;
  };
  return { context, run, serve, state };
}

test('yt-main.js: 包んだ関数の toString が元の関数と同じに見える', () => {
  const { run } = makePage();
  const fetchBefore = run('fetch.toString()');
  const parseBefore = run('JSON.parse.toString()');
  const jsonBefore = run('Response.prototype.json.toString()');
  const toStringBefore = run('Function.prototype.toString.toString()');
  run(SOURCE);
  assert.equal(run('fetch.toString()'), fetchBefore);
  assert.equal(run('String(fetch)'), fetchBefore);
  assert.equal(run('Function.prototype.toString.call(fetch)'), fetchBefore);
  assert.equal(run('fetch.name'), 'fetch');
  assert.equal(run('fetch.length'), 2);
  assert.equal(run('JSON.parse.toString()'), parseBefore);
  assert.equal(run('Response.prototype.json.toString()'), jsonBefore);
  assert.equal(run('Function.prototype.toString.toString()'), toStringBefore);
  // 関数でないものに対しては、元と同じ TypeError
  assert.throws(() => run('Function.prototype.toString.call({})'), /Function\.prototype\.toString requires that 'this' be a Function/);
});

test('yt-main.js: JSON.parse と Response.prototype.json は改変しない（広告のキーを含む偽の応答を、元のまま通す）', async () => {
  const { run } = makePage();
  run('globalThis.__parse = JSON.parse; globalThis.__json = Response.prototype.json;');
  run(SOURCE);
  assert.equal(run('JSON.parse === __parse && Response.prototype.json === __json'), true);
  const fake = '{"adPlacements":[1],"adSlots":[2],"playerAds":[3],"playerResponse":{"adPlacements":[4]},"auxiliaryUi":{"messageRenderers":{"bkaEnforcementMessageViewModel":{"x":1}}}}';
  assert.equal(run(`JSON.stringify(JSON.parse('${fake}'))`), fake);
  assert.equal(await run(`new Response('${fake}').json().then((v) => JSON.stringify(v))`), fake);
});

test('yt-main.js: 実際の URL が /youtubei/v1/ の fetch の応答から、広告のキーだけを取り除く（検出メッセージは残す）', async () => {
  const { run, serve } = makePage();
  run(SOURCE);
  serve(PLAYER_URL, { adPlacements: [1], adSlots: [2], playerAds: [3], auxiliaryUi: { messageRenderers: MESSAGE }, videoDetails: { videoId: 'v' } });
  const response = await run(`fetch('${PLAYER_URL}', { method: 'POST' })`);
  assert.equal(response.url, PLAYER_URL);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=UTF-8');
  assert.deepEqual(await response.json(), { auxiliaryUi: { messageRenderers: MESSAGE }, videoDetails: { videoId: 'v' } });
});

test('yt-main.js: playerResponse に包まれた応答・配列の応答も取り除く', async () => {
  const { run, serve } = makePage();
  run(SOURCE);
  const inner = () => ({ adPlacements: [1], auxiliaryUi: { messageRenderers: { ...MESSAGE } }, videoDetails: { videoId: 'v' } });
  const expected = { auxiliaryUi: { messageRenderers: MESSAGE }, videoDetails: { videoId: 'v' } };
  serve('https://www.youtube.com/youtubei/v1/next', { playerResponse: inner(), keep: 1 });
  assert.deepEqual(await (await run("fetch('https://www.youtube.com/youtubei/v1/next')")).json(), { playerResponse: expected, keep: 1 });
  serve('https://m.youtube.com/youtubei/v1/player', [{ playerResponse: inner() }]);
  assert.deepEqual(await (await run("fetch('https://m.youtube.com/youtubei/v1/player')")).json(), [{ playerResponse: expected }]);
});

test('yt-main.js: 広告のキーがない応答は、同じ Response をそのまま返す', async () => {
  const { run, serve } = makePage();
  run(SOURCE);
  const original = serve(PLAYER_URL, { videoDetails: { videoId: 'v' }, auxiliaryUi: { messageRenderers: { keepMe: 1 } } });
  assert.equal(await run(`fetch('${PLAYER_URL}')`), original);
});

test('yt-main.js: 検査用の偽の応答（data: URL・別のサイト・JSON 以外・失敗した応答）は、広告のキーがあっても触らない', async () => {
  const { run, serve } = makePage();
  run(SOURCE);
  const body = { adPlacements: [1], auxiliaryUi: { messageRenderers: { bkaEnforcementMessageViewModel: { x: 1 } } } };
  // YouTube の検査は、data: URL の Request の url / method を、プレイヤー API のものに見せかけて fetch する。
  // Request の url は偽装できるが、返ってくる Response.url は実際の URL（data:）になる
  run(`globalThis.__request = { get url() { return '${PLAYER_URL}'; }, get method() { return 'POST'; } };`);
  const decoy = serve('data:application/json;base64,e30=', body);
  assert.equal(await run('fetch(__request)'), decoy);
  assert.equal(await decoy.text(), JSON.stringify(body));
  const original = JSON.stringify(body);
  const cases = [
    ['https://example.com/youtubei/v1/player', body, {}],
    ['https://www.youtube.com/api/stats/qoe', body, {}],
    ['https://www.youtube.com.evil.example/youtubei/v1/player', body, {}],
    [PLAYER_URL, original, { contentType: 'text/plain' }],
    [PLAYER_URL, body, { status: 404 }],
  ];
  for (const [url, payload, options] of cases) {
    const response = serve(url, payload, options);
    const got = await run(`fetch('${url}')`);
    assert.equal(got, response, url);
    assert.equal(await got.text(), original, url);
  }
});

test('yt-main.js: fetch に渡した引数と this はそのまま元の fetch に届く', async () => {
  const { run, serve, state } = makePage();
  run(SOURCE);
  serve(PLAYER_URL, { videoDetails: {} });
  await run(`fetch('${PLAYER_URL}', { method: 'POST', body: 'x' })`);
  assert.deepEqual(state.calls, [JSON.stringify([PLAYER_URL, { method: 'POST', body: 'x' }])]);
});

test('yt-main.js: ytInitialPlayerResponse に代入された広告のキーを取り除く（検出メッセージは残す）', () => {
  const { run } = makePage();
  run(SOURCE);
  run('window.ytInitialPlayerResponse = { adPlacements: [1], adSlots: [2], playerAds: [3], title: "t" };');
  assert.equal(run('JSON.stringify(window.ytInitialPlayerResponse)'), '{"title":"t"}');
  const withMessage = '{"auxiliaryUi":{"messageRenderers":{"bkaEnforcementMessageViewModel":{"displayType":"P"}}},"title":"t"}';
  run(`window.ytInitialPlayerResponse = ${withMessage};`);
  assert.equal(run('JSON.stringify(window.ytInitialPlayerResponse)'), withMessage);
});

test('yt-main.js: 検出メッセージだけの応答は、解析し直さずにそのまま返す', async () => {
  const { run, serve } = makePage();
  run(SOURCE);
  const original = serve(PLAYER_URL, { auxiliaryUi: { messageRenderers: MESSAGE }, videoDetails: { videoId: 'v' } });
  assert.equal(await run(`fetch('${PLAYER_URL}')`), original);
});
