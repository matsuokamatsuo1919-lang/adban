// ADBAN の計測ハーネス。拡張機能を入れた Chrome(adban)と、入れていない Chrome(baseline)で
// 同じサイトを開き、通信・広告の残り方・壊れ具合・広告ブロッカー検出を測る。
// 使い方は tools/e2e/README.md を参照。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Manager } from './lib/manager.mjs';
import { measureSite, measureDetector, slugify } from './lib/measure.mjs';
import { DETECTORS } from './detectors.mjs';
import { measureYoutubeSet, VIDEOS_FILE } from './youtube.mjs';
import { writeReport } from './report.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXT_SRC = path.resolve(HERE, '..', '..');

// ---- 引数 ----
const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
if (flag('help') || flag('h')) {
  console.log(`使い方: node tools/e2e/run.mjs [オプション]
  --mode adban|baseline|both   既定 both
  --sites <json>               既定 tools/e2e/sites.json
  --only <カテゴリ名 or URL の一部>  カンマ区切りで複数可。detector で検出テストページだけ
  --out <dir>                  既定 tools/e2e/out/<日時>/
  --concurrency N              既定 3(モードごとの同時タブ数)
  --settle <秒>                既定 8(読み込み後の待ち)
  --youtube                    YouTube の広告表示秒数も測る(動画は tools/e2e/youtube-videos.json。--video <url> で 1 本だけ指定)
  --quick                      sites.json で quick:true の代表サイト(14 件程度)+ 検出ページだけ。2〜3 分
  --youtube-file <json>        --youtube の動画一覧(既定 tools/e2e/youtube-videos.json。相対パスはリポジトリのルート基準)
  --no-detectors               検出テストページを計測しない
  --ext <dir>                  読み込む拡張機能のディレクトリ(既定はリポジトリのルート。例: dist/package)
  --browser chrome|edge        既定 chrome
  --headed                     headless にせず、画面外のウィンドウで動かす`);
  process.exit(0);
}
const mode = opt('mode', 'both');
if (!['adban', 'baseline', 'both'].includes(mode)) { console.error('--mode は adban|baseline|both'); process.exit(2); }
const sitesFile = path.resolve(opt('sites', path.join(HERE, 'sites.json')));
const only = opt('only', '');
const concurrency = Math.max(1, Number(opt('concurrency', 3)));
const settle = Number(opt('settle', 8));
const headless = !flag('headed');
// 読み込む拡張機能のディレクトリ(既定はリポジトリのルート。公開版 dist/package を測るときに指定する)と、ブラウザー(既定 chrome)
const EXT_DIR = path.resolve(opt('ext', EXT_SRC));
const browserOpt = opt('browser', 'chrome');
const stampLocal = (() => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`; })();
const outDir = path.resolve(opt('out', path.join(HERE, 'out', stampLocal)));
fs.mkdirSync(outDir, { recursive: true });
const modes = mode === 'both' ? ['baseline', 'adban'] : [mode];

const log = (...a) => console.log(new Date().toTimeString().slice(0, 8), ...a);

// ---- 対象の選択 ----
const allSites = JSON.parse(fs.readFileSync(sitesFile, 'utf8'));
const keys = only.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const matches = (s, extra = '') => !keys.length || keys.some((k) => s.category === k || s.url.toLowerCase().includes(k) || (extra && extra.toLowerCase().includes(k)));
const sites = allSites.filter((s) => matches(s) && (!flag('quick') || s.quick));
let dets = [];
if (!flag('no-detectors')) {
  dets = DETECTORS.filter((d) => !keys.length || keys.some((k) => k === 'detector' || d.url.toLowerCase().includes(k) || d.name.toLowerCase().includes(k)));
}
log(`対象: サイト ${sites.length} 件、検出ページ ${dets.length} 件、モード ${modes.join('+')}、同時 ${concurrency}、待ち ${settle} 秒`);
log(`出力: ${outDir}`);

// ---- 実行 ----
const data = {
  meta: { startedAt: new Date().toISOString(), mode, concurrency, settle, headless, only, sitesFile, argv },
  sites: sites.map((s) => ({ url: s.url, category: s.category, note: s.note })),
  detectors: dets.map((d) => ({ name: d.name, url: d.url, note: d.note })),
  youtube: null,
};
const t0 = Date.now();
const managers = {};

async function runWithRetry(mgr, fn) {
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    let b;
    try { b = await mgr.get(); } catch (e) { return { error: 'ブラウザを起動できません: ' + e.message }; }
    try {
      last = await fn(b);
    } catch (e) {
      last = { error: e.message };
    }
    // Chrome が落ちていたら、起動し直してもう 1 回だけやり直す
    if (last.error && !b.alive && attempt === 0) { log(`[${mgr.mode}] ブラウザが落ちたので再試行します`); continue; }
    return last;
  }
  return last;
}

async function runMode(m) {
  const mgr = new Manager({ mode: m, extSrc: EXT_DIR, headless, log });
  managers[m] = mgr;
  if (browserOpt === 'edge') { mgr.methods = [{ browser: 'edge', method: 'flag' }, { browser: 'edge', method: 'pipe' }]; mgr.baselineBrowser = 'edge'; }
  if (m === 'baseline' && managers.adban) mgr.baselineBrowser = undefined;
  const tasks = [
    ...sites.map((s, i) => ({ kind: 'site', i })),
    ...dets.map((d, i) => ({ kind: 'det', i })),
  ];
  let next = 0, done = 0;
  const shotDir = path.join(outDir, 'shots', m);
  async function worker() {
    while (next < tasks.length) {
      const task = tasks[next++];
      let res;
      if (task.kind === 'site') {
        const s = sites[task.i];
        res = await runWithRetry(mgr, (b) => measureSite(b, s, { settle, shotFile: path.join(shotDir, slugify(s.url) + '.png') }));
        data.sites[task.i][m] = res;
        done++;
        log(`[${m}] ${done}/${tasks.length} ${s.url}  req=${res.net?.total ?? '-'} blocked=${res.net?.blocked ?? '-'} adLike=${res.dom ? res.dom.adIframes + res.dom.adElems : '-'}${res.error ? '  ERROR: ' + res.error : ''}`);
      } else {
        const d = dets[task.i];
        res = await runWithRetry(mgr, (b) => measureDetector(b, d, { shotFile: path.join(shotDir, 'detector_' + slugify(d.url) + '.png'), detailDir: path.join(outDir, 'detectors', slugify(d.url), m) }));
        data.detectors[task.i][m] = res;
        done++;
        log(`[${m}] ${done}/${tasks.length} 検出ページ ${d.name}: ${res.error ? 'ERROR ' + res.error : res.text}  blocked=${res.net?.blocked ?? '-'}`);
      }
    }
  }
  // 先にブラウザを 1 回起動しておく(同時起動を避ける)
  try { await mgr.get(); } catch (e) { log(`[${m}] 起動失敗: ${e.message}`); }
  await Promise.all(Array.from({ length: concurrency }, worker));
}

let finalized = false;
async function finalize() {
  if (finalized) return;
  finalized = true;
  data.meta.finishedAt = new Date().toISOString();
  data.meta.durationSec = Math.round((Date.now() - t0) / 1000);
  for (const m of modes) if (managers[m]?.info) data.meta[m] = managers[m].info;
  for (const m of Object.keys(managers)) { try { await managers[m].close(); } catch { /* 無視 */ } }
  writeReport(data, outDir);
  log(`レポート: ${path.join(outDir, 'report.md')}(${data.meta.durationSec} 秒)`);
}
process.on('SIGINT', async () => { log('中断。ここまでの結果でレポートを書きます'); await finalize(); process.exit(130); });

try {
  await Promise.all(modes.map(runMode));
  if (flag('youtube')) {
    log('YouTube を計測します');
    const one = opt('video', null);
    const videos = one ? [{ url: one, label: one }] : JSON.parse(fs.readFileSync(opt('youtube-file', null) ? path.resolve(EXT_SRC, opt('youtube-file', null)) : VIDEOS_FILE, 'utf8'));
    data.youtube = await measureYoutubeSet(managers, modes, videos, { outDir, seconds: 45, log });
  }
} finally {
  await finalize();
}
