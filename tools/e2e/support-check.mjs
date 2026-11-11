// 「問題を報告」の入口（ポップアップ・設定画面）を、実際のブラウザーで確かめる。
//   node tools/e2e/support-check.mjs [--ext <dir>] [--browser chrome|edge]
//   --ext      確かめる拡張機能のディレクトリ（既定はリポジトリのルート（開発用フォルダー）。公開版は dist/package を指定する）
//   --browser  chrome（既定）または edge
//
// 確かめること（ポップアップと設定画面のそれぞれで）:
//   (i)   入口が表示される
//   (ii)  押すと、報告の種類のメニューが出る（設定画面は、種類のボタンが並ぶ）
//   (iii) 種類を選ぶと、クリップボードに報告用の文章が入る（navigator.clipboard.writeText を差し替えて、呼ばれた引数を取る）
//   (iv)  lib/support.js の SUPPORT_URL が未設定のとき、タブは開かず、メッセージが出る
//   (v)   設定済み（lib/support.js を書き換えた拡張機能のコピー）のとき、サポート窓口のページが新しいタブで開く。
//         GitHub の Issues の URL ならテンプレート名つきの URL、それ以外ならそのままの URL。クエリに利用者の情報は付かない
//   ほか: コピーに失敗したとき（writeText が拒否される）、選んでコピーできる欄が出て、タブは開かない（ポップアップ）
// 既存の tools/e2e/ のファイルは変更していない。ブラウザーの起動は lib/browser.mjs を使う。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyExtension, launchWithExtension, rmDirSafe, sleep } from './lib/browser.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const extSrc = path.resolve(opt('ext', ROOT));
const browserName = opt('browser', 'chrome');
const methods = browserName === 'edge'
  ? [{ browser: 'edge', method: 'flag' }, { browser: 'edge', method: 'pipe' }]
  : [{ browser: 'chrome', method: 'pipe' }, { browser: 'chrome', method: 'flag' }];

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'OK ' : 'NG '} ${name}${detail ? ` … ${detail}` : ''}`);
};

// 拡張機能のコピーの lib/support.js の定数を書き換える（テスト用。元のファイルは変えない）
function copyWithSupport(urls) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adban-support-ext-'));
  copyExtension(extSrc, dir);
  const file = path.join(dir, 'lib', 'support.js');
  let src = fs.readFileSync(file, 'utf8');
  for (const [name, url] of Object.entries(urls)) {
    src = src.replace(new RegExp(`^export const ${name} = '[^']*';$`, 'm'), `export const ${name} = '${url}';`);
  }
  fs.writeFileSync(file, src);
  return dir;
}

async function pages(b) {
  const { targetInfos } = await b.send('Target.getTargets');
  return targetInfos.filter((t) => t.type === 'page').map((t) => ({ id: t.targetId, url: t.url }));
}

// 前の一覧になかったタブの URL（同じ URL のタブが前にあっても、新しく開いたものを数える）
const newUrls = (before, after) => after.filter((t) => !before.some((o) => o.id === t.id)).map((t) => t.url);

async function openPage(b, url) {
  const { targetId } = await b.send('Target.createTarget', { url });
  const { sessionId } = await b.send('Target.attachToTarget', { targetId, flatten: true });
  const ev = async (expression) => {
    const r = await b.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  };
  for (let i = 0; i < 50; i++) { // 読み込みと、モジュールの先頭の await が終わるまで待つ
    try { if (await ev("document.readyState === 'complete'")) break; } catch { /* 待つ */ }
    await sleep(200);
  }
  await sleep(1500);
  return { ev, targetId };
}

// クリップボードへの書き込みを差し替える。mode: 'ok'（引数を window.__copied に入れる）または 'fail'（拒否する）
const stubClipboard = (mode) => `
  window.__copied = null;
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: async (t) => { ${mode === 'fail' ? "throw new Error('denied')" : 'window.__copied = t'}; },
  } });
  true`;

const visible = (sel) => `(() => { const e = document.querySelector(${JSON.stringify(sel)}); return !!e && !e.hidden && e.offsetParent !== null; })()`;

async function waitFor(ev, expression, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await ev(expression)) return true; } catch { /* 待つ */ }
    await sleep(150);
  }
  return false;
}

const REPORT_HEAD = '# ADBAN 報告用の情報';

async function scenario(label, urls, expectOpen) {
  const dir = copyWithSupport(urls);
  const { browser: b } = await launchWithExtension({ extSrc: dir, methods, log: console.log });
  try {
    const base = `chrome-extension://${b.extId}`;
    console.log(`--- ${label}（${b.version}、拡張機能 ID ${b.extId}）`);

    // ポップアップ
    const popup = await openPage(b, `${base}/popup/popup.html`);
    await popup.ev(stubClipboard('ok'));
    check(`[${label}] ポップアップ: 入口「問題を報告」が表示される`, await popup.ev(visible('#reportToggle')) && /問題を報告/.test(await popup.ev("document.getElementById('reportToggle').textContent")));
    check(`[${label}] ポップアップ: 最初はメニューが閉じている`, !(await popup.ev(visible('#reportMenu'))));
    await popup.ev("document.getElementById('reportToggle').click()");
    check(`[${label}] ポップアップ: 押すとメニュー（3 種類）が出る`, await popup.ev(visible('#reportMenu')) && (await popup.ev("document.querySelectorAll('#reportMenu [data-kind]').length")) === 3);

    const before = await pages(b);
    await popup.ev("document.querySelector('#reportMenu [data-kind=\"ad-remains\"]').click()");
    const copied = await waitFor(popup.ev, 'window.__copied !== null');
    const text = copied ? await popup.ev('window.__copied') : '';
    check(`[${label}] ポップアップ: 選ぶとクリップボードに報告用の文章が入る`, copied && text.startsWith(REPORT_HEAD) && text.includes('個人情報（名前・メールアドレス・パスワード・住所など）は書かないでください') && text.includes('- ドメイン名: なし'), `${text.length} 文字`);
    check(`[${label}] ポップアップ: 文章に URL・userAgent の全文が入っていない`, !/https?:\/\/|chrome-extension|Mozilla|AppleWebKit/.test(text));
    await sleep(2000);
    const after = await pages(b);
    const opened = newUrls(before, after);
    const msg = await popup.ev("document.getElementById('reportMsg').textContent");
    if (expectOpen) {
      check(`[${label}] ポップアップ: サポート窓口のページが新しいタブで開く`, opened.length === 1 && opened[0].startsWith(expectOpen.prefix), opened.join(' '));
      check(`[${label}] ポップアップ: 開く URL は想定どおり（クエリはテンプレート名だけ）`, opened[0] === expectOpen.url, opened[0]);
      check(`[${label}] ポップアップ: 「コピーしました。開いたページに貼り付けてください」が出る`, msg.includes('報告用の情報をコピーしました') && msg.includes('貼り付けてください'), msg);
    } else {
      check(`[${label}] ポップアップ: 未設定ならタブを開かない`, opened.length === 0, opened.join(' '));
      check(`[${label}] ポップアップ: 「サポート窓口の URL が未設定です」が出る`, msg.includes('サポート窓口の URL が未設定です'), msg);
    }

    // コピーに失敗したとき
    await popup.ev(stubClipboard('fail'));
    await popup.ev("document.getElementById('reportToggle').click()");
    const before2 = await pages(b);
    await popup.ev("document.querySelector('#reportMenu [data-kind=\"site-broken\"]').click()");
    const shown = await waitFor(popup.ev, "!document.getElementById('reportText').hidden");
    await sleep(1500);
    const after2 = await pages(b);
    check(`[${label}] ポップアップ: コピーに失敗すると、選んでコピーできる欄が出て、タブは開かない`,
      shown && (await popup.ev("document.getElementById('reportText').value")).startsWith(REPORT_HEAD) && after2.length === before2.length);

    // 設定画面
    const options = await openPage(b, `${base}/options/options.html`);
    await options.ev(stubClipboard('ok'));
    check(`[${label}] 設定画面: 「意見・不具合の報告」の欄とボタン 3 つが表示される`,
      (await options.ev("[...document.querySelectorAll('h2')].some((h) => h.textContent.includes('意見・不具合の報告'))")) && (await options.ev("document.querySelectorAll('#reportButtons [data-kind]').length")) === 3 && await options.ev(visible('#reportButtons')));
    const preview = await options.ev("document.getElementById('reportPreview').value");
    check(`[${label}] 設定画面: コピーされる内容のプレビューが出る`, preview.startsWith(REPORT_HEAD) && preview.includes('- ADBAN の版:'), `${preview.length} 文字`);
    const linksShown = await options.ev("!document.getElementById('privacyLink').hidden && !document.getElementById('sourceLink').hidden");
    const linksHidden = await options.ev("document.getElementById('privacyLink').hidden && document.getElementById('sourceLink').hidden");
    if (expectOpen) {
      check(`[${label}] 設定画面: プライバシーポリシー・ソースコードのリンクが出る`, linksShown && (await options.ev("document.getElementById('privacyLink').href")) === urls.PRIVACY_URL);
    } else {
      check(`[${label}] 設定画面: 未設定ならリンクは出ない`, linksHidden);
    }
    const before3 = await pages(b);
    await options.ev("document.querySelector('#reportButtons [data-kind=\"other\"]').click()");
    const copied3 = await waitFor(options.ev, 'window.__copied !== null');
    check(`[${label}] 設定画面: 選ぶとクリップボードに報告用の文章が入る`, copied3 && (await options.ev('window.__copied')).startsWith(REPORT_HEAD));
    await sleep(2000);
    const opened3 = newUrls(before3, await pages(b));
    const status = await options.ev("document.getElementById('reportStatus').textContent");
    if (expectOpen) {
      check(`[${label}] 設定画面: サポート窓口のページが新しいタブで開く`, opened3.length === 1 && opened3[0].startsWith(expectOpen.prefix), opened3.join(' '));
    } else {
      check(`[${label}] 設定画面: 未設定ならタブを開かず、メッセージが出る`, opened3.length === 0 && status.includes('未設定'), status);
    }
  } finally {
    await b.close();
    rmDirSafe(dir);
  }
}

console.log(`確かめる拡張機能: ${extSrc} / ブラウザー: ${browserName}`);
const unconfigured = /^export const SUPPORT_URL = '__SUPPORT_URL__';$/m.test(fs.readFileSync(path.join(extSrc, 'lib', 'support.js'), 'utf8'));
if (unconfigured) {
  // 未設定（目印のまま）の拡張機能でそのまま確かめる
  await scenario('未設定', {}, null);
} else {
  console.log('（lib/support.js の URL は設定済みなので、未設定の確認は省く）');
}
// 設定済み（GitHub 以外の URL。そのまま開く。実在しない .invalid のドメインなので、通信は起きない）
await scenario('設定済み', {
  SUPPORT_URL: 'https://support.invalid/adban/issues',
  SOURCE_URL: 'https://source.invalid/adban',
  PRIVACY_URL: 'https://privacy.invalid/adban',
}, { prefix: 'https://support.invalid/', url: 'https://support.invalid/adban/issues' });

const ng = results.filter((r) => !r.ok);
console.log(`\n${results.length - ng.length} / ${results.length} 項目 OK`);
if (ng.length) process.exitCode = 1;
