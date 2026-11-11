// 「問題を報告」の入口で使う小さな関数。ポップアップ・設定画面・テストで共有する。
// 自動では何も送らない。利用者がボタンを押したときだけ、報告用の文章をクリップボードにコピーし、サポート窓口のページを新しいタブで開く
// （利用者が、そのページに貼り付けて、自分で送る）。ここには、外部へ通信する処理はない。
//
// 公開用パッケージを作る前に、下の 3 つの定数を実際の URL に置き換える。
// 値は、アンダースコア 2 つ・名前・アンダースコア 2 つで囲んだ目印の文字列（宣言は 1 行ずつ）。
// tools/make-package.mjs は、この目印が残っていると、パッケージを作らずに失敗する。
// この説明のコメントには、目印そのものを書かないこと（書くと、置き換えたあとの検査が誤って反応する）。

import { hostOf, isListed } from './hosts.js';

export const SUPPORT_URL = 'https://github.com/matsuokamatsuo1919-lang/adban/issues';
export const SOURCE_URL = 'https://github.com/matsuokamatsuo1919-lang/adban';
export const PRIVACY_URL = 'https://matsuokamatsuo1919-lang.github.io/adban/privacy';

/** URL が設定済みか（目印のままでなく、https:// で始まるか）。 */
export function isConfigured(url) {
  return typeof url === 'string' && /^https:\/\/[^\s/]+/.test(url);
}

// 報告の種類 → GitHub の Issue テンプレート名
const TEMPLATES = {
  'ad-remains': 'ad-remains.yml',
  'site-broken': 'site-broken.yml',
  other: 'feature-request.yml',
};

export const REPORT_KINDS = [
  { kind: 'ad-remains', label: '広告が残っている' },
  { kind: 'site-broken', label: 'ページが壊れた・表示がおかしい' },
  { kind: 'other', label: 'ご意見・ご要望' },
];

/**
 * 報告の種類に応じて、サポート窓口で開く URL を返す。未設定なら null。
 * GitHub の Issues（https://github.com/<アカウント>/<リポジトリ>/issues。末尾の / はあってもなくてもよい）なら、
 * テンプレートを開く URL（.../issues/new?template=<名前>.yml）にする。それ以外の URL はそのまま返す。
 * クエリには、テンプレート名のほか、利用者の情報は何も入れない。
 */
export function reportTarget(kind, supportUrl = SUPPORT_URL) {
  if (!isConfigured(supportUrl)) return null;
  const base = supportUrl.replace(/[/?#]+$/, '');
  if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues$/i.test(base)) {
    return `${base}/new?template=${TEMPLATES[kind] ?? TEMPLATES.other}`;
  }
  return supportUrl;
}

// ---- 報告用の文章 ----

/** userAgent から { name, version }（Edge / Chrome / その他）。全文は返さない。 */
export function parseBrowser(userAgent = '') {
  const edge = /\bEdg(?:e|A|iOS)?\/(\d[\d.]*)/.exec(userAgent);
  if (edge) return { name: 'Edge', version: edge[1] };
  const chrome = /\bChrome\/(\d[\d.]*)/.exec(userAgent);
  if (chrome) return { name: 'Chrome', version: chrome[1] };
  return { name: 'その他', version: '' };
}

/** userAgent から OS の名前だけ。 */
export function parseOS(userAgent = '') {
  if (/\bCrOS\b/.test(userAgent)) return 'ChromeOS';
  if (/\bWindows\b/.test(userAgent)) return 'Windows';
  if (/\bMac OS X\b|\bMacintosh\b/.test(userAgent)) return 'macOS';
  if (/\bAndroid\b/.test(userAgent)) return 'その他';
  if (/\bLinux\b|\bX11\b/.test(userAgent)) return 'Linux';
  return 'その他';
}

const onOff = (value) => (value ? 'オン' : 'オフ');

/** 自分で書いたフィルターの行数（空行と ! で始まるコメント行を除く）。中身は返さない。 */
function countFilterLines(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .filter((line) => {
      const s = line.trim();
      return s && !s.startsWith('!');
    }).length;
}

function latestDate(lists) {
  let best = 0;
  for (const l of lists) {
    const t = Date.parse(l?.updated ?? '');
    if (t > best) best = t;
  }
  return best ? new Date(best).toISOString().slice(0, 10) : '不明';
}

/**
 * 報告用の文章（日本語。見出しつきの箇条書き）を作る。純粋関数（DOM・chrome API に依存しない）。
 * info:
 *   version        拡張機能の版
 *   userAgent      navigator.userAgent（版と OS の名前だけを取り出す。全文は入れない）
 *   meta           rules/meta.json の中身（lists の name・updated を使う）
 *   rulesetIds     manifest のルールセットの id の一覧
 *   settings       { enabled, allowlist, customFilters, disabledRulesets, youtubePrune, collapseSlots, collapsePromo, pvDiagEnabled }
 *   tabUrl         いま開いているタブの URL（ホスト名だけを取り出す。http(s) 以外は「なし」）
 *   blocked        そのタブで止めた件数（数でなければ「不明」）
 * 入れないもの: URL 全文・パス・クエリ・ページのタイトル・許可リストと自分のフィルターの中身・診断（pvDiag）の中身・閲覧履歴・アカウント情報。
 */
export function buildReport(info = {}) {
  const s = info.settings ?? {};
  const browser = parseBrowser(info.userAgent);
  const host = hostOf(info.tabUrl ?? '');
  const allowlist = Array.isArray(s.allowlist) ? s.allowlist : [];
  const disabled = Array.isArray(s.disabledRulesets) ? s.disabledRulesets : [];
  const metaLists = Array.isArray(info.meta?.lists) ? info.meta.lists : [];
  const ids = Array.isArray(info.rulesetIds) ? info.rulesetIds : metaLists.map((l) => l.id);
  const enabledLists = ids.filter((id) => !disabled.includes(id));
  const enabledInfo = enabledLists.map((id) => metaLists.find((l) => l.id === id) ?? { id });
  const enabled = s.enabled !== false;
  const blocked = Number.isFinite(info.blocked) ? String(info.blocked) : '不明';

  return [
    '# ADBAN 報告用の情報',
    '（ここまでの内容は、ADBAN が自動で集めたものです。貼り付ける前に、内容を確認・編集できます）',
    '',
    '## 環境',
    `- ADBAN の版: ${info.version ?? '不明'}`,
    `- ブラウザー: ${browser.name}${browser.version ? ` ${browser.version}` : ''}`,
    `- OS: ${parseOS(info.userAgent)}`,
    '',
    '## フィルターリスト',
    `- リストの更新日: ${latestDate(enabledInfo)}`,
    `- 有効なリスト: ${enabledInfo.length ? enabledInfo.map((l) => l.name ?? l.id).join('、') : 'なし'}`,
    '',
    '## 設定',
    `- 全体のブロック: ${onOff(enabled)}`,
    `- このサイトでのブロック: ${host ? onOff(!isListed(allowlist, host)) : 'なし'}`,
    `- YouTube の広告データの除去: ${onOff(s.youtubePrune !== false)}`,
    `- 空の広告枠のたたみ込み: ${onOff(s.collapseSlots !== false)}`,
    `- 記事広告のたたみ込み: ${onOff(s.collapsePromo !== false)}`,
    `- ブロックしないサイト: ${allowlist.length} 件（中身は含みません）`,
    `- 自分で書いたフィルター: ${countFilterLines(s.customFilters)} 行（中身は含みません）`,
    `- Prime Video の診断の記録: ${onOff(s.pvDiagEnabled === true)}`,
    '',
    '## いま開いているページ',
    `- ドメイン名: ${host || 'なし'}（パス・クエリ・タイトルは含みません）`,
    `- このページで止めた件数: ${host ? blocked : 'なし'}`,
    '',
    '---',
    '',
    '## 何が起きましたか',
    '',
    '',
    '## どのページ（URL）でしたか（書いても書かなくても構いません）',
    '',
    '',
    '## いつからですか',
    '',
    '',
    '※ 個人情報（名前・メールアドレス・パスワード・住所など）は書かないでください。',
    '',
  ].join('\n');
}

// ---- 画面から使う部分（利用者が押したときだけ動く。外部へ送る処理はない） ----

const SETTING_DEFAULTS = {
  enabled: true,
  allowlist: [],
  customFilters: '',
  disabledRulesets: [],
  youtubePrune: true,
  collapseSlots: true,
  collapsePromo: true,
  pvDiagEnabled: false,
};

/** 拡張機能の中のデータ（設定・rules/meta.json・manifest）から、buildReport に渡す info を集める。 */
export async function collectInfo({ tab, blocked } = {}) {
  const manifest = chrome.runtime.getManifest();
  const meta = await fetch(chrome.runtime.getURL('rules/meta.json'))
    .then((r) => r.json())
    .catch(() => ({ lists: [] }));
  const settings = await chrome.storage.local.get(SETTING_DEFAULTS); // pvDiag は読まない
  return {
    version: manifest.version,
    userAgent: navigator.userAgent,
    meta,
    rulesetIds: manifest.declarative_net_request?.rule_resources?.map((r) => r.id) ?? [],
    settings,
    tabUrl: tab?.url ?? '',
    blocked,
  };
}

/** クリップボードにコピーする。できなければ false（呼び出し側が、選んでコピーできる欄を出す）。 */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** サポート窓口のページを新しいタブで開く。未設定なら何もせず false。 */
export async function openSupport(kind) {
  const url = reportTarget(kind);
  if (!url) return false;
  await chrome.tabs.create({ url });
  return true;
}
