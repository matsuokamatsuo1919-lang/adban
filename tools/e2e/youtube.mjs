// YouTube の動画ページを開いて 45 秒間、広告が映る秒数・広告ブロッカーの警告などを 1 秒おきに記録する。
// 動画の一覧は tools/e2e/youtube-videos.json(sites.json とは別枠)。
// 単体実行: node tools/e2e/youtube.mjs [--mode adban|baseline|both] [--video <url>] [--seconds 45] [--out <dir>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sleep, withTimeout } from './lib/browser.mjs';
import { Manager } from './lib/manager.mjs';
import { Page } from './lib/measure.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_VIDEO = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
export const VIDEOS_FILE = path.join(HERE, 'youtube-videos.json');

const SAMPLE = `(() => {
  const vis = (sel) => {
    for (const e of document.querySelectorAll(sel)) {
      const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
      if (r.width * r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) !== 0) return e;
    }
    return null;
  };
  const p = document.querySelector('#movie_player');
  const v = document.querySelector('video');
  const BLK = /広告ブロッカー|広告ブロック|Ad blockers?|ad ?block/i;
  const enf = vis('ytd-enforcement-message-view-model');
  let dlg = null;
  for (const e of document.querySelectorAll('tp-yt-paper-dialog, ytd-popup-container, ytd-enforcement-message-view-model, yt-playability-error-supported-renderers, .ytp-error, yt-confirm-dialog-renderer')) {
    const r = e.getBoundingClientRect();
    if (r.width * r.height > 0 && BLK.test(e.innerText || '')) { dlg = (e.innerText || '').replace(/\\s+/g, ' ').slice(0, 140); break; }
  }
  const pe = vis('yt-playability-error-supported-renderers') || vis('.ytp-error');
  const peText = pe ? (pe.innerText || '').replace(/\\s+/g, ' ').slice(0, 140) : '';
  const pr = p ? p.getBoundingClientRect() : null;
  return {
    adShowing: !!p && p.classList.contains('ad-showing'),
    overlay: !!vis('.ytp-ad-player-overlay, .ytp-ad-player-overlay-layout'),
    adText: !!vis('.ytp-ad-text, .ytp-ad-preview-text, .ytp-ad-simple-ad-badge'),
    skip: !!vis('.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern'),
    enforcement: !!enf,
    blockerDialog: dlg,
    playError: peText,
    rate: v ? v.playbackRate : null,
    muted: v ? v.muted : null,
    paused: v ? v.paused : null,
    time: v ? Math.round(v.currentTime * 10) / 10 : null,
    duration: v && isFinite(v.duration) ? Math.round(v.duration) : null,
    player: pr ? [Math.round(pr.left + pr.width / 2), Math.round(pr.top + pr.height / 2)] : null,
    title: document.title,
  };
})()`;

const TRY_PLAY = `(() => {
  const v = document.querySelector('video');
  if (v && v.paused) { const r = v.play(); if (r && r.catch) r.catch(() => {}); }
  return !!v;
})()`;

// 止まっているときだけ再生を試みる(再生中に触ると一時停止してしまうため)。
// 3 秒以上止まったままなら video.play()、それでも止まっていれば本物のクリック(広告表示中は誤クリックを避けて k キー)
async function nudgePlay(page, s, i, result) {
  result.pausedRun = s.paused === true ? (result.pausedRun || 0) + 1 : 0;
  if (result.pausedRun < 3) return;
  try { await page.eval(TRY_PLAY, { timeout: 3000 }); } catch { /* 無視 */ }
  if (result.pausedRun < 5 || result.pausedRun % 3 !== 2) return;
  try {
    const [x, y] = s.player || [500, 300];
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    if (s.adShowing) {
      await page.eval("document.querySelector('#movie_player')?.focus()", { timeout: 2000 });
      for (const type of ['keyDown', 'keyUp']) await page.send('Input.dispatchKeyEvent', { type, key: 'k', code: 'KeyK', text: type === 'keyDown' ? 'k' : undefined, windowsVirtualKeyCode: 75 });
    } else {
      await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    }
    result.playClicks = (result.playClicks || 0) + 1;
  } catch { /* 無視 */ }
}

export async function measureYoutube(browser, { url = DEFAULT_VIDEO, seconds = 45, shotDir, mode, label }) {
  const page = new Page(browser);
  const result = { mode, url, label: label || url, seconds, samples: [] };
  const work = (async () => {
    await page.open();
    await page.navigate(url, 25000);
    result.loadMs = page.loadMs;
    for (let i = 0; i < seconds; i++) {
      let s = null;
      try { s = await page.eval(SAMPLE, { timeout: 3000 }); } catch (e) { s = { error: e.message }; }
      result.samples.push({ t: i, ...s });
      if (s && !s.error) await nudgePlay(page, s, i, result);
      if (i === 12 && shotDir) {
        try { const f = path.join(shotDir, 'youtube_' + (label || 'watch').replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 30) + '.png'); await page.screenshot(f); result.shot = f; } catch { /* 無視 */ }
      }
      await sleep(1000);
    }
  })();
  try {
    await withTimeout(work, (seconds + 45) * 1000, 'YouTube 計測がタイムアウト');
  } catch (e) { result.error = e.message; }
  const S = result.samples.filter((s) => !s.error);
  const count = (f) => S.filter(f).length;
  const times = S.map((s) => s.time).filter((x) => typeof x === 'number');
  const rates = [...new Set(S.map((s) => s.rate).filter((x) => x != null))];
  result.summary = {
    sampled: S.length,
    adShowingSeconds: count((s) => s.adShowing),
    overlaySeconds: count((s) => s.overlay),
    adTextSeconds: count((s) => s.adText),
    anyAdSeconds: count((s) => s.adShowing || s.overlay || s.adText),
    skipButtonSeconds: count((s) => s.skip),
    pausedSeconds: count((s) => s.paused),
    mutedSeconds: count((s) => s.muted),
    rates,
    fastRate: rates.some((r) => r > 1),
    maxVideoTime: times.length ? Math.max(...times) : null,
    enforcementSeconds: count((s) => s.enforcement),
    blockerDialogSeconds: count((s) => s.blockerDialog),
    blockerDialogText: S.find((s) => s.blockerDialog)?.blockerDialog || '',
    playErrorSeconds: count((s) => s.playError),
    playErrorText: S.find((s) => s.playError)?.playError || '',
    playClicks: result.playClicks || 0,
    title: S.find((s) => s.title)?.title || '',
  };
  result.summary.adblockWarning = result.summary.enforcementSeconds > 0 || result.summary.blockerDialogSeconds > 0;
  result.net = page.netSummary(url);
  await page.close();
  return result;
}

/** 複数の動画を、モードごとに順番に測る(モード同士は並行)。baseline で広告が出なかった動画は comparable=false */
export async function measureYoutubeSet(managers, modes, videos, { outDir, seconds = 45, log = () => {} }) {
  const per = {};
  await Promise.all(modes.map(async (m) => {
    per[m] = [];
    for (const v of videos) {
      let r;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const b = await managers[m].get();
          r = await measureYoutube(b, { url: v.url, seconds, shotDir: path.join(outDir, 'shots', m), mode: m, label: v.label });
        } catch (e) { r = { mode: m, url: v.url, label: v.label, error: e.message }; }
        if (!(r.error && /終了/.test(r.error))) break;
      }
      per[m].push(r);
      log(`[${m}] YouTube ${v.label}: ${r.error ? 'ERROR ' + r.error : `広告 ${r.summary.anyAdSeconds} 秒 / 警告 ${r.summary.adblockWarning} / 動画 ${r.summary.maxVideoTime} 秒`}`);
    }
  }));
  return videos.map((v, i) => {
    const b = per.baseline?.[i], a = per.adban?.[i];
    const out = { url: v.url, label: v.label, note: v.note, baseline: b, adban: a };
    out.comparable = !!(b && a && b.summary && b.summary.anyAdSeconds > 0);
    return out;
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
  const mode = opt('mode', 'both');
  const one = opt('video', null);
  const seconds = Number(opt('seconds', 45));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = path.resolve(opt('out', path.join(HERE, 'out', stamp + '_youtube')));
  const modes = mode === 'both' ? ['baseline', 'adban'] : [mode];
  const videos = one ? [{ url: one, label: one }] : JSON.parse(fs.readFileSync(VIDEOS_FILE, 'utf8'));
  const extSrc = path.resolve(HERE, '..', '..');
  const managers = {};
  for (const m of modes) managers[m] = new Manager({ mode: m, extSrc, log: console.log });
  let res;
  try { res = await measureYoutubeSet(managers, modes, videos, { outDir: out, seconds, log: console.log }); }
  finally { for (const m of modes) await managers[m].close(); }
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'youtube.json'), JSON.stringify(res, null, 2));
  console.log('出力:', out);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
