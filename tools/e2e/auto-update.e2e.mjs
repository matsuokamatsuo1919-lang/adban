// 自動再読み込み（auto-update.js）の実機確認。拡張機能入りの Chrome を起動し、拡張機能のコピー（一時ディレクトリ）の
// rules/meta.json を書き換えて、service worker が再読み込みするか・しないかを確かめる。
//   node tools/e2e/auto-update.e2e.mjs
// 周期（6 時間）を待たないよう、内部メッセージ {type:'update:check'} で確認を呼ぶ。
// idle の判定は、テスト専用の chrome.storage.local の updateTestNoIdle: true で飛ばす（本番では使わない）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchWithExtension, sleep } from './lib/browser.mjs';
import { EXT_METHODS } from './lib/manager.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_SRC = path.resolve(HERE, '..', '..');

const { browser: b } = await launchWithExtension({ extSrc: EXT_SRC, methods: EXT_METHODS, log: console.log });
const extDir = b.extCopy;
const metaPath = path.join(extDir, 'rules', 'meta.json');
const originalMeta = fs.readFileSync(metaPath, 'utf8');
const results = [];
let exitCode = 0;

// 拡張機能のページ（options）を開いて式を評価する。service worker は自分にメッセージを送れないため
async function inExtensionPage(expression) {
  const { targetId } = await b.send('Target.createTarget', { url: `chrome-extension://${b.extId}/options/options.html` });
  const { sessionId } = await b.send('Target.attachToTarget', { targetId, flatten: true });
  try {
    // ページが読み込まれて chrome.storage が使えるようになるまで待つ
    for (let i = 0; i < 40; i++) {
      const ready = await b.send('Runtime.evaluate', { expression: 'typeof chrome !== "undefined" && !!chrome.storage && !!chrome.runtime?.sendMessage', returnByValue: true }, sessionId).catch(() => null);
      if (ready?.result?.value) break;
      await sleep(250);
    }
    const r = await b.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description ?? ''));
    return r.result?.value;
  } finally {
    await b.send('Target.closeTarget', { targetId }).catch(() => {});
  }
}

// service worker の中で式を評価する
async function inWorker(expression) {
  const { targetInfos } = await b.send('Target.getTargets');
  const sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${b.extId}/`));
  if (!sw) throw new Error('service worker のターゲットがない');
  const { sessionId } = await b.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true });
  try {
    const r = await b.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    return r.result?.value;
  } finally {
    await b.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  }
}

const check = () => inExtensionPage(`chrome.runtime.sendMessage({ type: 'update:check' })`);
const setLocal = (obj) => inExtensionPage(`chrome.storage.local.set(${JSON.stringify(obj)})`);
const removeLocal = (keys) => inExtensionPage(`chrome.storage.local.remove(${JSON.stringify(keys)})`);

// 目印を置いておき、再読み込みで service worker が作り直されると消えることで、再読み込みを見分ける
const mark = () => inWorker(`globalThis.__marker = 1`);
const marked = () => inWorker(`globalThis.__marker === 1`);

function writeMeta(mutate) {
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  mutate(meta);
  fs.writeFileSync(metaPath, `${JSON.stringify(meta)}\n`);
}
const touchMeta = () => writeMeta((m) => { m.lists[0].updated = new Date().toISOString() + Math.random(); });

// 再読み込みを見届ける: service worker のターゲットが消える（または目印が消える）まで待つ。
// CDP の Extensions.loadUnpacked で入れた拡張機能は、chrome.runtime.reload() のあと無効のまま戻らない（実際のブラウザーでは戻る）ので、
// 再読み込みを見届けるテストは最後に 1 回だけ行う。
async function waitReloaded() {
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const { targetInfos } = await b.send('Target.getTargets');
      if (!targetInfos.some((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${b.extId}/`))) return true;
      if ((await marked()) === false) return true;
    } catch {
      return true;
    }
  }
  return false;
}

async function test(name, fn) {
  try {
    await fn();
    results.push(['PASS', name]);
  } catch (e) {
    exitCode = 1;
    results.push(['FAIL', `${name}: ${e.message}`]);
  }
}

try {
  await setLocal({ updateTestNoIdle: true });
  await mark();

  await test('変更がなければ same（基準が覚えられている）', async () => {
    const r = await check();
    assert.ok(['same', 'baseline'].includes(r.status), r.status);
    assert.equal((await check()).status, 'same');
    assert.equal(await marked(), true);
  });

  await test('autoReload がオフなら、meta.json が変わっても何もしない', async () => {
    await setLocal({ autoReload: false });
    touchMeta();
    assert.equal((await check()).status, 'disabled');
    await sleep(1500);
    assert.equal(await marked(), true, '再読み込みされた');
    await removeLocal(['autoReload']);
  });

  await test('meta.json が壊れている・rules/ のファイルが途中で切れているときは再読み込みしない', async () => {
    const target = path.join(extDir, 'rules', 'easylist.json');
    const whole = fs.readFileSync(target, 'utf8');
    try {
      fs.writeFileSync(metaPath, '{"lists":[');
      assert.equal((await check()).status, 'unreadable');
      fs.writeFileSync(metaPath, originalMeta);
      touchMeta();
      fs.writeFileSync(target, whole.slice(0, Math.floor(whole.length / 2)));
      assert.equal((await check()).status, 'unreadable');
      await sleep(1500);
      assert.equal(await marked(), true, '再読み込みされた');
    } finally {
      fs.writeFileSync(target, whole);
    }
  });

  await test('再読み込みの直後 5 分間は、また変わっても再読み込みしない', async () => {
    await setLocal({ updateLastReload: Date.now() });
    touchMeta();
    assert.equal((await check()).status, 'cooldown');
    await sleep(1500);
    assert.equal(await marked(), true, '再読み込みされた');
    await removeLocal(['updateLastReload']);
  });

  await test('meta.json が変わり、rules/ が全部読めて、待ち時間も過ぎていれば再読み込みする', async () => {
    assert.equal((await check()).status, 'reloading');
    assert.equal(await waitReloaded(), true, '再読み込みされなかった');
  });
} catch (e) {
  exitCode = 1;
  results.push(['FAIL', `実行できませんでした: ${e.message}`]);
} finally {
  await b.close();
}

for (const [mark1, line] of results) console.log(`${mark1}  ${line}`);
process.exit(exitCode);
