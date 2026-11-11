// 広告のポップアップ（window.open・target=_blank で開かれる広告のタブ、ポップアンダー）を閉じる。
// フィルターの $popup（rules/popups.json と、自分で書いたフィルター）に当てはまる URL のタブだけを閉じる。
// declarativeNetRequest ではポップアップだけを区別できないので、webNavigation で新しく開かれたタブを見張る。
//
// 流れ:
//   1. onCreatedNavigationTarget で、新しいタブを「ポップアップの候補」として CANDIDATE_MS の間だけ覚える
//   2. 候補のタブのナビゲーション（最初の URL・about:blank からの遷移・リダイレクト後の URL・# の変更）のたびに判定する
//   3. $popup のフィルターに一致し、例外（@@...$popup）に当たらなければ、タブを閉じる。一致しなければ何もしない
// 設定（全体のオン・オフ、許可リスト、使わないリスト、自分のフィルター）は background.js と同じ chrome.storage.local から読む。

import { compilePopupText, PopupMatcher } from './lib/popup.js';
import { hostOf, isListed } from './lib/hosts.js';

const CANDIDATE_MS = 10_000;
const DEFAULTS = { enabled: true, allowlist: [], customFilters: '', disabledRulesets: [] };

let settings = { ...DEFAULTS };
let settingsReady = Promise.resolve();
function loadSettings() {
  settingsReady = chrome.storage.local
    .get(Object.keys(DEFAULTS))
    .then((stored) => {
      settings = { ...DEFAULTS, ...stored };
    })
    .catch((e) => console.error('[ADBAN popup]', e));
}
loadSettings();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && Object.keys(changes).some((k) => k in DEFAULTS)) loadSettings();
});

// rules/popups.json（tools/build-filters.mjs が作る）。ファイルがなければ、自分のフィルターだけで動く
let fileData;
const loadFile = () =>
  (fileData ??= fetch(chrome.runtime.getURL('rules/popups.json'))
    .then((r) => r.json())
    .catch(() => ({ lists: {} })));

let matcherKey = null;
let matcher = null;
async function getMatcher() {
  await settingsReady;
  const key = JSON.stringify([settings.disabledRulesets, settings.customFilters]);
  if (matcher && key === matcherKey) return matcher;
  const { lists = {} } = await loadFile();
  const used = Object.entries(lists)
    .filter(([id]) => !settings.disabledRulesets.includes(id))
    .map(([, data]) => data);
  if (settings.customFilters.includes('popup')) used.push(compilePopupText(settings.customFilters).data);
  matcherKey = key;
  matcher = new PopupMatcher(used);
  return matcher;
}

// ---- 候補のタブ ----

const candidates = new Map(); // タブ ID → { sourceTabId, sourceUrl（Promise）, timer }

async function tabUrl(tabId) {
  try {
    return (await chrome.tabs.get(tabId)).url ?? '';
  } catch {
    return ''; // 開いた元のタブはもう閉じられた
  }
}

function forget(tabId) {
  const c = candidates.get(tabId);
  if (!c) return;
  clearTimeout(c.timer);
  candidates.delete(tabId);
  if (!candidates.size) unwatch();
}

async function check(tabId, url) {
  const c = candidates.get(tabId);
  if (!c || !/^https?:/i.test(url)) return;
  const [m, sourceUrl] = await Promise.all([getMatcher(), c.sourceUrl]);
  if (!settings.enabled || isListed(settings.allowlist, hostOf(sourceUrl)) || !candidates.has(tabId)) return;
  if (m.match(url, sourceUrl) !== 'block') return;
  forget(tabId);
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    return; // 先に閉じられた
  }
  // アイコンの数字に加える（DNR の件数と同じ、開いた元のタブの分）
  chrome.declarativeNetRequest.setExtensionActionOptions({ tabUpdate: { tabId: c.sourceTabId, increment: 1 } }).catch(() => {});
}

// 候補があるあいだだけ、ナビゲーションを見張る（ふだんは service worker を起こさない）
const onNavigation = (d) => {
  if (d.frameId === 0) check(d.tabId, d.url);
};
const NAV_EVENTS = ['onBeforeNavigate', 'onCommitted', 'onReferenceFragmentUpdated', 'onHistoryStateUpdated'];
let watching = false;
function watch() {
  if (watching) return;
  watching = true;
  for (const name of NAV_EVENTS) chrome.webNavigation[name].addListener(onNavigation);
}
function unwatch() {
  if (!watching) return;
  watching = false;
  for (const name of NAV_EVENTS) chrome.webNavigation[name].removeListener(onNavigation);
}

chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => {
  forget(d.tabId);
  candidates.set(d.tabId, {
    sourceTabId: d.sourceTabId,
    sourceUrl: tabUrl(d.sourceTabId),
    timer: setTimeout(() => forget(d.tabId), CANDIDATE_MS),
  });
  watch();
  check(d.tabId, d.url);
});
chrome.tabs.onRemoved.addListener((tabId) => forget(tabId));
