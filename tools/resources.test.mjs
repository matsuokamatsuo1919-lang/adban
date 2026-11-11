// lib/resources.js と resources/ の偽物ファイルのテスト。  node --test "tools/*.test.mjs"

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { RESOURCE_FILES, redirectPath } from '../lib/resources.js';

const read = (name) => readFileSync(new URL(`../resources/${name}`, import.meta.url));

/** 疑似のページを作り、偽物の JS を読み込んで結果の window を返す。 */
function runInPage(name, { src = '' } = {}) {
  const cookies = [];
  const document = {
    currentScript: { src },
    querySelectorAll: () => [],
    createElement: () => ({ style: { setProperty() {} }, appendChild() {} }),
    get cookie() { return cookies.join('; '); },
    set cookie(v) { cookies.push(v); },
  };
  const window = { document, requestAnimationFrame: (f) => setTimeout(f, 0) };
  window.self = window;
  const ctx = vm.createContext({ window, document, self: window, requestAnimationFrame: window.requestAnimationFrame, setTimeout, console, Promise, Date, Math });
  vm.runInContext(read(name).toString('utf8'), ctx);
  return { window, cookies };
}

test('対応表のファイルがすべて resources/ に存在する', () => {
  for (const file of RESOURCE_FILES) assert.ok(existsSync(new URL(`../resources/${file}`, import.meta.url)), file);
});

test('追加した名前と別名が resources/ のファイルに対応する', () => {
  const expected = {
    'google-ima.js': 'google-ima.js',
    'google-ima3': 'google-ima.js',
    'noopmp3-0.1s': 'noop-0.1s.mp3',
    'noop-0.1s.mp3': 'noop-0.1s.mp3',
    'noopmp4-1s': 'noop-1s.mp4',
    'noop-1s.mp4': 'noop-1s.mp4',
    'fingerprint2.js': 'fingerprint2.js',
    'noopjs': 'noop.js',
    'noop.js': 'noop.js',
    'nobab2.js': 'nobab2.js',
    'chartbeat.js': 'chartbeat.js',
    'hd-main.js': 'hd-main.js',
    'adthrive_abd.js': 'adthrive_abd.js',
    'nitropay_ads.js': 'nitropay_ads.js',
    'sensors-analytics.js': 'sensors-analytics.js',
    'amazon-adsystem.com/aax2/amzn_ads.js': 'amazon_ads.js',
  };
  for (const [name, file] of Object.entries(expected)) assert.equal(redirectPath(name), `/resources/${file}`, name);
  assert.equal(redirectPath('no-such-resource'), null);
});

test('MP3 は MP3 のフレーム、MP4 は ftyp で始まる', () => {
  const mp3 = read('noop-0.1s.mp3');
  assert.ok((mp3[0] === 0xff && (mp3[1] & 0xe0) === 0xe0) || mp3.subarray(0, 3).toString() === 'ID3');
  assert.equal(read('noop-1s.mp4').subarray(4, 8).toString(), 'ftyp');
});

test('追加した JS の偽物は構文が正しく、例外なく読み込める', () => {
  for (const f of ['google-ima.js', 'fingerprint2.js', 'nobab2.js', 'chartbeat.js', 'hd-main.js', 'adthrive_abd.js', 'nitropay_ads.js', 'sensors-analytics.js', 'amazon_ads.js']) {
    assert.doesNotThrow(() => runInPage(f), f);
  }
});

test('google-ima.js: AdsLoader の要求から広告なしで完了までイベントが流れる', async () => {
  const { window } = runInPage('google-ima.js');
  const ima = window.google.ima;
  assert.ok(ima.VERSION);
  const adDisplayContainer = new ima.AdDisplayContainer({ appendChild() {} }, {});
  adDisplayContainer.initialize();
  const loader = new ima.AdsLoader(adDisplayContainer);
  const seen = [];
  let manager = null;
  const done = new Promise((resolve) => {
    loader.addEventListener(ima.AdsManagerLoadedEvent.Type.ADS_MANAGER_LOADED, (e) => {
      seen.push('LOADED');
      manager = e.getAdsManager({});
      for (const type of Object.values(ima.AdEvent.Type)) {
        manager.addEventListener(type, (ev) => {
          seen.push(ev.type);
          assert.doesNotThrow(() => ev.getAd());
          if (ev.type === ima.AdEvent.Type.CONTENT_RESUME_REQUESTED) resolve();
        });
      }
      manager.init(640, 360, 'normal');
      manager.start();
    }, false);
    loader.addEventListener(ima.AdErrorEvent.Type.AD_ERROR, (e) => {
      seen.push('ERROR');
      assert.doesNotThrow(() => { e.getError().getErrorCode(); e.getUserRequestContext(); });
    }, false);
  });
  const request = new ima.AdsRequest();
  request.adTagUrl = 'https://example.invalid/vast';
  request.setAdWillAutoPlay(true);
  loader.requestAds(request);
  await done;
  assert.ok(seen.includes('LOADED'));
  assert.ok(seen.includes('allAdsCompleted'));
  assert.ok(seen.indexOf('contentPauseRequested') < seen.indexOf('contentResumeRequested'));
  assert.doesNotThrow(() => { manager.resize(1, 1, 'normal'); manager.setVolume(0); manager.destroy(); loader.contentComplete(); loader.destroy(); });
});

test('google-ima.js: 既にある google.ima は上書きしない', () => {
  const ctx = vm.createContext({ window: {}, document: {} });
  ctx.window.google = { ima: { VERSION: 'real' } };
  vm.runInContext(read('google-ima.js').toString('utf8'), ctx);
  assert.equal(ctx.window.google.ima.VERSION, 'real');
});

test('各偽物が window に置く名前', () => {
  assert.equal(typeof runInPage('chartbeat.js').window.pSUPERFLY.activity, 'function');
  assert.equal(typeof runInPage('nitropay_ads.js').window.nitroAds.createAd, 'function');
  assert.equal(typeof runInPage('sensors-analytics.js').window.sensorsDataAnalytic201505.track, 'function');
  assert.equal(typeof runInPage('hd-main.js').window.L.Ad, 'function');
  const amz = runInPage('amazon_ads.js').window;
  assert.equal(typeof amz.amznads.getAds, 'function');
  assert.equal(typeof amz.aax_write, 'function');
  assert.match(runInPage('adthrive_abd.js').cookies[0], /^__adblocker=false;/);
});

test('fingerprint2.js: 空の結果をコールバックと Promise で返す', async () => {
  const { window } = runInPage('fingerprint2.js');
  const fp = window.Fingerprint2;
  assert.equal((await fp.getPromise()).length, 0);
  assert.equal((await new Promise((r) => fp.get({}, r))).length, 0);
  assert.equal(typeof fp.x64hash128('a'), 'string');
});

test('nobab2.js: 対象の配信元から読み込まれたときだけ働く', () => {
  assert.equal(runInPage('nobab2.js', { src: 'https://x.adclixx.net/a.js' }).window.nH7eXzOsG, 858);
  assert.equal(runInPage('nobab2.js', { src: 'https://example.com/a.js' }).window.nH7eXzOsG, undefined);
});
