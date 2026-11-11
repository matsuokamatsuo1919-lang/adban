// フィルターリストの更新を自動で取り込む。
// Manifest V3 では静的ルール（rules/*.json）やスクリプレット（content scripts のファイル）を実行時に書き換えられないので、
// パソコン側で tools/build-filters.mjs を定期実行（tools/update-filters.ps1）し、拡張機能は自分の rules/meta.json の変化を見て
// chrome.runtime.reload() で読み込み直す。
//
// 再読み込みするのは、次のすべてを満たしたときだけ:
//   - 設定の autoReload がオン（既定）
//   - 拡張機能を読み込んだ時点の meta.json と、今の meta.json の内容（SHA-256）が違う
//   - rules/ のファイルがすべて読めて（JSON として解析できて）、確かめている間に meta.json が変わらなかった（ビルドの途中ではない）
//   - 前回の再読み込みから 5 分以上たっている（再読み込みを繰り返さない）
//   - ユーザーが 60 秒以上操作していない（chrome.idle が idle か locked。動画の視聴中などを邪魔しない）
// 条件を満たさなかったときは、10 分後（または 6 時間ごとの次の周期）にもう一度確かめる。
// 再読み込みしても、すでに開いているタブの content script は古い状態のまま孤立する（ページを開き直すと新しいものが入る）。
//
// 公開版（tools/make-package.mjs が作るパッケージ）の manifest.json には alarms・idle の権限がない（この仕組みは、パソコン側のビルドを使う
// 開発用なので）。そのとき chrome.alarms / chrome.idle は未定義なので、何も登録せず、何もしないで終わる（UPDATE_SUPPORTED）。

const CHECK_ALARM = 'adban-update-check'; // 6 時間ごと
const RETRY_ALARM = 'adban-update-retry'; // 条件を満たさなかったときの 10 分後
const PERIOD_MINUTES = 360;
const RETRY_MINUTES = 10;
const COOLDOWN_MS = 5 * 60 * 1000;
const IDLE_SECONDS = 60;

// alarms と idle の権限があるとき（開発用の manifest.json）だけ動く
export const UPDATE_SUPPORTED = typeof chrome.alarms?.create === 'function' && typeof chrome.idle?.queryState === 'function';

const metaUrl = () => chrome.runtime.getURL('rules/meta.json');

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// meta.json を読む。読めない・解析できないときは null
async function readMeta() {
  try {
    const response = await fetch(metaUrl(), { cache: 'no-store' });
    if (!response.ok) return null;
    const text = await response.text();
    const meta = JSON.parse(text);
    if (!meta || !Array.isArray(meta.lists)) return null;
    return { meta, signature: await sha256(text) };
  } catch {
    return null;
  }
}

async function fetchOk(path, parse) {
  const response = await fetch(chrome.runtime.getURL(path), { cache: 'no-store' });
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  const text = await response.text();
  return parse(text);
}

// rules/ のファイルが（ビルドの途中ではなく）すべて読めるか
async function rulesReadable(meta) {
  const ids = chrome.runtime.getManifest().declarative_net_request.rule_resources.map((r) => r.id);
  try {
    for (const id of ids) {
      if (!Array.isArray(await fetchOk(`rules/${id}.json`, JSON.parse))) return false;
      if (!(await fetchOk(`rules/${id}.cosmetic.json`, JSON.parse))) return false;
    }
    await fetchOk('rules/popups.json', JSON.parse);
    for (const list of meta.lists) {
      if (!list.scriptlets) continue;
      const { shards } = await fetchOk(`rules/${list.id}.scriptlets.json`, JSON.parse);
      for (const k of Object.keys(shards ?? {})) {
        // ファイルの先頭と末尾で、途中で切れていないことを確かめる
        const ok = await fetchOk(`rules/scriptlets/${list.id}.${k}.js`, (t) => t.startsWith('(self.__adbanScriptlets') && t.endsWith(';\n'));
        if (!ok) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function scheduleRetry() {
  chrome.alarms.create(RETRY_ALARM, { delayInMinutes: RETRY_MINUTES });
}

// 基準（拡張機能を読み込んだ時点の meta.json）を覚える。chrome.storage.session は再読み込みで消えるので、
// 再読み込みのあとは新しい meta.json が基準になる
async function ensureBaseline() {
  const { updateBaseline } = await chrome.storage.session.get('updateBaseline');
  if (updateBaseline) return updateBaseline;
  const current = await readMeta();
  if (!current) return null;
  await chrome.storage.session.set({ updateBaseline: current.signature });
  return current.signature;
}

// meta.json の変化を確かめ、条件がそろっていれば再読み込みする。結果は { status }（テスト・診断用）
//   disabled / baseline / same / unreadable / cooldown / busy / reloading
export async function checkForUpdate() {
  if (!UPDATE_SUPPORTED) return { status: 'unsupported' };
  const { autoReload = true, updateTestNoIdle = false } = await chrome.storage.local.get(['autoReload', 'updateTestNoIdle']);
  if (autoReload === false) return { status: 'disabled' };

  const baseline = await ensureBaseline();
  const current = await readMeta();
  if (!current) return { status: 'unreadable' };
  if (!baseline) return { status: 'baseline' };
  if (current.signature === baseline) return { status: 'same' };

  // 変わっていた。ビルドの途中でないことを確かめる（rules/ が全部読めて、確かめている間に meta.json が変わらない）
  if (!(await rulesReadable(current.meta))) {
    scheduleRetry();
    return { status: 'unreadable' };
  }
  const again = await readMeta();
  if (!again || again.signature !== current.signature) {
    scheduleRetry();
    return { status: 'unreadable' };
  }

  const { updateLastReload = 0 } = await chrome.storage.local.get('updateLastReload');
  if (Date.now() - updateLastReload < COOLDOWN_MS) {
    scheduleRetry();
    return { status: 'cooldown' };
  }

  // 動画の視聴中などを邪魔しない。ユーザーが操作していないときだけ（テストでは updateTestNoIdle で飛ばせる）
  if (!updateTestNoIdle) {
    const state = await chrome.idle.queryState(IDLE_SECONDS);
    if (state === 'active') {
      scheduleRetry();
      return { status: 'busy' };
    }
  }

  await chrome.storage.local.set({ updateLastReload: Date.now() });
  // メッセージで呼ばれたときに返事を返せるよう、少しあとに再読み込みする
  setTimeout(() => chrome.runtime.reload(), 100);
  return { status: 'reloading' };
}

const safeCheck = () => checkForUpdate().catch((e) => console.error('[ADBAN]', e));

if (UPDATE_SUPPORTED) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === CHECK_ALARM || alarm.name === RETRY_ALARM) safeCheck();
  });

  // 内部メッセージ（テスト・診断用）: 周期を待たずに確かめる
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || message?.type !== 'update:check') return false;
    checkForUpdate().then(sendResponse, (e) => sendResponse({ status: 'error', error: String(e?.message ?? e) }));
    return true;
  });

  // 起動時: 基準を覚え、6 時間ごとの確認を用意する（すでにあるなら、起こされるたびに周期をずらさない）
  ensureBaseline().catch(() => {});
  chrome.alarms.get(CHECK_ALARM).then((alarm) => {
    if (!alarm) chrome.alarms.create(CHECK_ALARM, { delayInMinutes: 1, periodInMinutes: PERIOD_MINUTES });
  });
}
