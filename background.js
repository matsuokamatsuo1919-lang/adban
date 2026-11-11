// ADBAN の service worker。
//  - 設定（chrome.storage.local）に合わせて、ネットワークのブロックルールを切り替える
//  - ページから届く情報を受けて、広告を隠す CSS を chrome.scripting.insertCSS で入れる
//  - 広告ブロッカー対策を止めるスクリプレット（content/scriptlets.js）を、対象のサイトにだけ登録する

import { ALLOW_ID_BASE, CUSTOM_ID_BASE, compileFilterList, isUsableSelector } from './lib/filters.js';
import { CosmeticEngine, hideRule, styleRule } from './lib/cosmetic.js';
import { hostOf, isListed, siteKey } from './lib/hosts.js';
import { SCRIPTLET_ENTITY_TLDS } from './lib/entity-tlds.js';
import './popup-blocker.js'; // 広告のポップアップを閉じる（$popup）
import './auto-update.js'; // rules/meta.json の更新を見て、自動で再読み込みする

const DEFAULTS = {
  enabled: true,
  allowlist: [],
  customFilters: '',
  disabledRulesets: [],
  youtubePrune: true,
  pvDiagEnabled: false, // Prime Video の診断を chrome.storage.local の pvDiag に記録する（既定はオフ。設定画面で利用者がオンにしたときだけ）
  collapseSlots: true, // 広告の中身が消えたあとに残る空の枠をたたむ（content/slots.js）
  collapsePromo: true, // 「PR」「広告」などの表記がある記事広告のカードを隠す（content/slots.js）
};

// 動的ルールのうち、拡張機能が内部で使うもの（CUSTOM_ID_BASE 未満）
const RULE_ID = { disableAll: 1, allowlist: 2 };
const STATIC_RULESETS = chrome.runtime.getManifest().declarative_net_request.rule_resources.map((r) => r.id);
const YOUTUBE_SCRIPT_ID = 'adban-youtube';
const SCRIPTLET_SCRIPT_ID = 'adban-scriptlets';
const YOUTUBE_HOST_RE = /(^|\.)(youtube|youtube-nocookie)\.com$/;
const PRIME_VIDEO_HOST_RE = /(^|\.)primevideo\.com$|(^|\.)amazon\.(com|co\.jp|co\.uk|de|fr|it|es|ca|com\.au|com\.br|com\.mx|in|nl|se|pl|sg|com\.tr|ae|sa|eg|com\.be)$/;

let settings = { ...DEFAULTS };
let engine = new CosmeticEngine([]);
let customRules = [];
const ruleFiles = new Map(); // rules/ のファイル名 → 中身（service worker が起きている間だけ持つ）

const activeRulesets = () => STATIC_RULESETS.filter((id) => !settings.disabledRulesets.includes(id));
const allowDomains = () => settings.allowlist.filter((d) => /^[a-z0-9_.-]+$/.test(d));

async function loadSettings() {
  settings = { ...DEFAULTS, ...(await chrome.storage.local.get(Object.keys(DEFAULTS))) };
}

function loadRuleFile(name) {
  if (!ruleFiles.has(name)) {
    const url = chrome.runtime.getURL(`rules/${name}`);
    ruleFiles.set(name, fetch(url).then((r) => r.json()).catch(() => null));
  }
  return ruleFiles.get(name);
}
const loadCosmetic = (id) => loadRuleFile(`${id}.cosmetic.json`);

async function rebuild() {
  const custom = compileFilterList(settings.customFilters, { firstId: CUSTOM_ID_BASE, firstAllowId: ALLOW_ID_BASE });
  customRules = custom.rules;
  const datasets = await Promise.all(activeRulesets().map(loadCosmetic));
  engine = new CosmeticEngine([...datasets, custom.cosmetic]);
}

// 設定を読み直す。apply が true なら、ブラウザー側（ルール・バッジなど）にも反映する。
// ページからのメッセージは ready（設定の読み込み）だけを待つので、常に最新の設定ですぐに答えられる。
// ブラウザー側への反映（スクリプレットの登録し直しなど、数秒かかることがある）は applying で順番に行う。
let ready = Promise.resolve();
let applying = Promise.resolve();
function refresh(apply) {
  const loaded = ready.then(async () => {
    await loadSettings();
    await rebuild();
  });
  ready = loaded.catch((e) => console.error('[ADBAN]', e));
  if (apply) applying = Promise.all([applying, ready]).then(applyBrowserState).catch((e) => console.error('[ADBAN]', e));
  return ready;
}
refresh(false);

async function applyBrowserState() {
  const dnr = chrome.declarativeNetRequest;
  const status = { rulesetError: '', customRuleError: '' };

  // 配布リストのルール
  const wanted = settings.enabled ? activeRulesets() : [];
  try {
    await dnr.updateEnabledRulesets({
      enableRulesetIds: wanted,
      disableRulesetIds: STATIC_RULESETS.filter((id) => !wanted.includes(id)),
    });
  } catch (e) {
    // ルール数の上限を超えたときは、前のリストから有効にできるところまで有効にする
    status.rulesetError = e.message;
    await dnr.updateEnabledRulesets({ disableRulesetIds: STATIC_RULESETS }).catch(() => {});
    for (const id of wanted) await dnr.updateEnabledRulesets({ enableRulesetIds: [id] }).catch(() => {});
  }

  // 全体のオフ・許可リスト・自分で追加したフィルター
  const system = [];
  if (!settings.enabled) {
    system.push({
      id: RULE_ID.disableAll,
      priority: 1000,
      action: { type: 'allowAllRequests' },
      condition: { resourceTypes: ['main_frame', 'sub_frame'] },
    });
  }
  if (allowDomains().length) {
    system.push({
      id: RULE_ID.allowlist,
      priority: 1000,
      action: { type: 'allowAllRequests' },
      condition: { requestDomains: allowDomains(), resourceTypes: ['main_frame', 'sub_frame'] },
    });
  }
  const removeRuleIds = (await dnr.getDynamicRules()).map((r) => r.id);
  try {
    await dnr.updateDynamicRules({ removeRuleIds, addRules: [...system, ...(settings.enabled ? customRules : [])] });
  } catch (e) {
    status.customRuleError = e.message;
    await dnr.updateDynamicRules({ removeRuleIds, addRules: system });
  }
  await chrome.storage.session.set(status);

  // バッジ（有効なときはタブごとのブロック件数、無効なときは OFF）
  await dnr.setExtensionActionOptions({ displayActionCountAsBadgeText: settings.enabled });
  await chrome.action.setBadgeBackgroundColor({ color: '#e5484d' });
  await chrome.action.setBadgeText({ text: settings.enabled ? '' : 'OFF' });

  await syncYouTubeScript();
  // 時間がかかることがあるので最後に行う
  await chrome.storage.session.set({ scriptletError: await syncScriptlets() });
}

// YouTube の広告データを取り除くスクリプトは、ページ側（MAIN world）で動かす必要があるので動的に登録する
async function syncYouTubeScript() {
  const want = settings.enabled && settings.youtubePrune && !isListed(settings.allowlist, 'www.youtube.com');
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [YOUTUBE_SCRIPT_ID] });
  if (registered.length) await chrome.scripting.unregisterContentScripts({ ids: [YOUTUBE_SCRIPT_ID] });
  if (want) {
    await chrome.scripting.registerContentScripts([
      {
        id: YOUTUBE_SCRIPT_ID,
        matches: ['https://*.youtube.com/*', 'https://*.youtube-nocookie.com/*'],
        js: ['content/yt-main.js'],
        runAt: 'document_start',
        world: 'MAIN',
        allFrames: true,
      },
    ]);
  }
}

// スクリプレットはページ側（MAIN world）で、ページのスクリプトより先に動かす必要があるので動的に登録する。
// 表はサイトごとにいくつかのファイルに分けてあり（tools/build-filters.mjs）、ファイルの組ごとに、
// 対象のサイト（rules/<リスト>.scriptlets.json）にだけ入れる。許可リストのサイトは除く。
// 2 万以上のサイトを登録し直すのには数秒かかるので、関係する設定もリストも変わっていなければ何もしない。
async function syncScriptlets() {
  const meta = (await loadRuleFile('meta.json')) ?? { lists: [] };
  const ids = settings.enabled
    ? activeRulesets().filter((id) => meta.lists.some((l) => l.id === id && l.scriptlets > 0))
    : [];
  const allow = allowDomains();
  const shards = new Map(); // 番号 → { files, hosts }
  for (const id of ids) {
    const data = await loadRuleFile(`${id}.scriptlets.json`);
    for (const [k, hosts] of Object.entries(data?.shards ?? {})) {
      if (!shards.has(k)) shards.set(k, { files: [], hosts: new Set() });
      const shard = shards.get(k);
      shard.files.push(`rules/scriptlets/${id}.${k}.js`);
      for (const h of hosts) {
        // example.*（エンティティ）は match pattern にワイルドカードがないので、TLD の一覧に展開する
        const expanded = h.endsWith('.*') ? SCRIPTLET_ENTITY_TLDS.map((t) => `${h.slice(0, -1)}${t}`) : [h];
        for (const d of expanded) if (!isListed(allow, d)) shard.hosts.add(d);
      }
    }
  }
  const scripts = [...shards]
    .filter(([, shard]) => shard.hosts.size)
    .map(([k, shard]) => ({
      id: `${SCRIPTLET_SCRIPT_ID}-${k}`,
      matches: [...shard.hosts].map((h) => `*://*.${h}/*`),
      ...(allow.length ? { excludeMatches: allow.map((d) => `*://*.${d}/*`) } : {}),
      js: [...shard.files, 'content/scriptlets.js'],
      runAt: 'document_start',
      world: 'MAIN',
      allFrames: true,
    }));

  const signature = JSON.stringify([
    chrome.runtime.getManifest().version,
    meta.lists.map((l) => [l.id, l.updated]),
    scripts.map((s) => [s.id, s.js, s.matches.length, s.excludeMatches ?? []]),
  ]);
  const registered = (await chrome.scripting.getRegisteredContentScripts())
    .map((s) => s.id)
    .filter((id) => id.startsWith(SCRIPTLET_SCRIPT_ID));
  const { scriptletSignature } = await chrome.storage.local.get('scriptletSignature');
  const sameIds = registered.sort().join() === scripts.map((s) => s.id).sort().join();
  if (sameIds && scriptletSignature === signature) return '';

  try {
    if (registered.length) await chrome.scripting.unregisterContentScripts({ ids: registered });
    if (scripts.length) await chrome.scripting.registerContentScripts(scripts);
    await chrome.storage.local.set({ scriptletSignature: signature });
    return '';
  } catch (e) {
    await chrome.storage.local.remove('scriptletSignature');
    return e.message;
  }
}

chrome.runtime.onInstalled.addListener(() => refresh(true));
chrome.runtime.onStartup.addListener(() => refresh(true));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && Object.keys(changes).some((k) => k in DEFAULTS)) refresh(true);
});

// ---- ページとのやりとり ----

function frameHost(sender) {
  for (const url of [sender.url, sender.origin, sender.tab?.url]) {
    const host = hostOf(url ?? '');
    if (host) return host;
  }
  return '';
}

// 広告を隠すべきフレームなら { host } を返す
function pageState(sender) {
  if (!settings.enabled || !sender.tab || sender.tab.id < 0) return null;
  const host = frameHost(sender);
  const top = sender.frameId === 0 ? host : hostOf(sender.tab.url ?? '');
  if (!host || isListed(settings.allowlist, top) || isListed(settings.allowlist, host)) return null;
  return { host };
}

async function insertCss(sender, css) {
  const target = sender.documentId
    ? { tabId: sender.tab.id, documentIds: [sender.documentId] }
    : { tabId: sender.tab.id, frameIds: [sender.frameId] };
  try {
    // USER にするとページ側の !important より強くなる
    await chrome.scripting.insertCSS({ target, css, origin: 'USER' });
  } catch {
    // 入れる前にページが閉じられた・移動した
  }
}

const UNLOCK_SCROLL = ['html:style(overflow: auto !important)', 'body:style(overflow: auto !important)'];

const strings = (value) =>
  Array.isArray(value) ? value.filter((s) => typeof s === 'string' && s.length <= 100).slice(0, 5000) : [];

const handlers = {
  async 'page:init'(message, sender) {
    const page = pageState(sender);
    if (!page) return { active: false };
    const css = engine.pageCss(page.host);
    if (css) await insertCss(sender, css);
    return {
      active: true,
      tokens: engine.usesTokens(page.host),
      youtube: YOUTUBE_HOST_RE.test(page.host),
      primevideo: PRIME_VIDEO_HOST_RE.test(page.host),
      pvDiag: settings.pvDiagEnabled === true,
      collapseSlots: settings.collapseSlots !== false,
      collapsePromo: settings.collapsePromo !== false,
    };
  },

  // 手続き型の要素隠し（content/procedural.js）。そのサイトに効くプログラムだけを返す。なければ空配列
  // （content/cosmetic.js の page:init とは別のメッセージにしてあるのは、あちらは CSS を入れる処理が重なるため）
  async 'page:procedural'(message, sender) {
    const page = pageState(sender);
    return { programs: page ? engine.proceduralFor(page.host) : [] };
  },

  async 'page:tokens'(message, sender) {
    const page = pageState(sender);
    if (!page) return {};
    const css = engine.tokenCss(page.host, strings(message.classes), strings(message.ids));
    if (css) await insertCss(sender, css);
    return {};
  },

  // 要素を選んでブロック（content/picker.js）。unlockScroll なら、画面を覆う警告に止められていたスクロールも戻す
  async 'picker:add'(message, sender) {
    const selector = String(message.selector ?? '').trim();
    const host = siteKey(frameHost(sender));
    if (!host || !sender.tab || !isUsableSelector(selector)) return { ok: false, error: 'この選択子は使えません' };
    const styles = message.unlockScroll ? UNLOCK_SCROLL : [];
    const filters = [`${host}##${selector}`, ...styles.map((s) => `${host}##${s}`)];
    const { customFilters = '' } = await chrome.storage.local.get('customFilters');
    const lines = new Set(customFilters.split(/\r?\n/).map((line) => line.trim()));
    const added = filters.filter((f) => !lines.has(f));
    if (added.length) {
      const text = customFilters.trimEnd();
      await chrome.storage.local.set({ customFilters: [...(text ? [text] : []), ...added].join('\n') });
    }
    await insertCss(sender, [hideRule(selector), ...styles.map(styleRule)].join('\n'));
    return { ok: true, filter: filters.join('\n') };
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !Object.hasOwn(handlers, message?.type)) return false;
  ready
    .then(() => handlers[message.type](message, sender))
    .then(sendResponse, (e) => sendResponse({ ok: false, error: String(e?.message ?? e) }));
  return true;
});
