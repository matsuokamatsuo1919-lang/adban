import { compileFilterList } from '../lib/filters.js';
import { normalizeDomain } from '../lib/hosts.js';
import { PRIVACY_URL, SOURCE_URL, SUPPORT_URL, buildReport, collectInfo, copyText, isConfigured, openSupport } from '../lib/support.js';

const $ = (id) => document.getElementById(id);
const rulesets = chrome.runtime.getManifest().declarative_net_request.rule_resources.map((r) => r.id);

const meta = await fetch('../rules/meta.json')
  .then((r) => r.json())
  .catch(() => ({ lists: [] }));

const settings = await chrome.storage.local.get({
  allowlist: [],
  customFilters: '',
  disabledRulesets: [],
  youtubePrune: true,
  pvDiagEnabled: false,
  collapseSlots: true,
  collapsePromo: true,
  autoReload: true,
});

const formatDate = (iso) =>
  iso ? new Date(iso).toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' }) : '未取得';

function renderLists() {
  const container = $('lists');
  container.replaceChildren();
  for (const id of rulesets) {
    const info = meta.lists.find((l) => l.id === id);
    const label = document.createElement('label');
    label.className = 'check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.dataset.ruleset = id;
    input.checked = !settings.disabledRulesets.includes(id);
    const text = document.createElement('span');
    text.textContent = info?.name ?? id;
    const small = document.createElement('small');
    const scriptlets = info?.scriptlets ? `・スクリプレット ${info.scriptlets.toLocaleString()} 件` : '';
    small.textContent = info
      ? `遮断 ${(info.network ?? info.rules).toLocaleString()} 件・要素隠し ${info.cosmetic.toLocaleString()} 件${scriptlets}・${formatDate(info.updated)}更新`
      : 'まだ取得していません';
    text.append(small);
    label.append(input, text);
    container.append(label);
  }
}

function showError(id, message) {
  $(id).textContent = message;
  $(id).hidden = !message;
}

async function showBackgroundStatus() {
  const {
    rulesetError = '',
    customRuleError = '',
    scriptletError = '',
  } = await chrome.storage.session.get(['rulesetError', 'customRuleError', 'scriptletError']);
  showError('rulesetError', rulesetError && `一部のリストを有効にできませんでした: ${rulesetError}`);
  showError('scriptletError', scriptletError && `スクリプレットを登録できませんでした: ${scriptletError}`);
  if (customRuleError) showError('customError', `ブラウザーがフィルターを受け付けませんでした: ${customRuleError}`);
}

renderLists();
$('youtubePrune').checked = settings.youtubePrune;
$('pvDiagEnabled').checked = settings.pvDiagEnabled === true;
$('collapseSlots').checked = settings.collapseSlots !== false;
$('collapsePromo').checked = settings.collapsePromo !== false;
$('autoReload').checked = settings.autoReload !== false;
// 公開版（alarms の権限がない）では自動更新は動かないので、チェックボックスと開発用の説明を隠す（data-dev-update）
if (typeof chrome.alarms === 'undefined') {
  for (const el of document.querySelectorAll('[data-dev-update]')) el.style.display = 'none';
}
$('allowlist').value = settings.allowlist.join('\n');
$('customFilters').value = settings.customFilters;
showBackgroundStatus();
chrome.storage.session.onChanged.addListener(showBackgroundStatus);

$('save').addEventListener('click', async () => {
  // 許可リスト
  const lines = $('allowlist').value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const invalid = lines.filter((l) => !normalizeDomain(l));
  const allowlist = [...new Set(lines.map(normalizeDomain).filter(Boolean))];
  showError('allowlistError', invalid.length ? `ドメインとして読めない行を除きました: ${invalid.join(', ')}` : '');
  $('allowlist').value = allowlist.join('\n');

  // 自分で追加したフィルター（書き方を確かめて件数を出す）
  const customFilters = $('customFilters').value;
  const { stats } = compileFilterList(customFilters);
  const notes = [];
  if (stats.skipped) notes.push(`${stats.skipped} 行は使えない書き方のため無視されます。`);
  if (stats.scriptlet) notes.push(`${stats.scriptlet} 行の +js(...) は配布リストでだけ使えるため、ここでは無視されます。`);
  showError('customError', notes.join(''));

  const disabledRulesets = [...document.querySelectorAll('[data-ruleset]')]
    .filter((input) => !input.checked)
    .map((input) => input.dataset.ruleset);

  await chrome.storage.local.set({
    allowlist,
    customFilters,
    disabledRulesets,
    youtubePrune: $('youtubePrune').checked,
    pvDiagEnabled: $('pvDiagEnabled').checked,
    collapseSlots: $('collapseSlots').checked,
    collapsePromo: $('collapsePromo').checked,
    autoReload: $('autoReload').checked,
  });
  $('status').textContent = `保存しました（ネットワーク ${stats.network} 件・要素隠し ${stats.cosmetic} 件）`;
});

// ---- Prime Video の診断（content/cosmetic.js が chrome.storage.local の pvDiag に残したものを、読む・コピーする・消す） ----

async function showDiagCount() {
  const { pvDiag } = await chrome.storage.local.get('pvDiag');
  const events = pvDiag?.events?.length ?? 0;
  const snapshots = pvDiag?.snapshots?.length ?? 0;
  $('pvDiagCount').textContent = events || snapshots
    ? `記録: 広告かもしれない場面 ${events} 件・定期の記録 ${snapshots} 件`
    : '記録: まだありません';
  $('pvDiagCopy').disabled = !(events || snapshots);
  $('pvDiagClear').disabled = !(events || snapshots);
}

$('pvDiagCopy').addEventListener('click', async () => {
  const { pvDiag } = await chrome.storage.local.get('pvDiag');
  const chromeMajor = /Chrome\/(\d+)/.exec(navigator.userAgent)?.[1] ?? '';
  const text = JSON.stringify(
    {
      app: 'ADBAN',
      kind: 'pvDiag',
      version: chrome.runtime.getManifest().version,
      chrome: chromeMajor,
      lang: navigator.language,
      copiedAt: new Date().toISOString(),
      note: 'before / after の各フレームで elements が無いものは直前のフレームと同じ。events は新しい順',
      ...pvDiag,
    },
    null,
    1,
  );
  try {
    await navigator.clipboard.writeText(text);
    $('pvDiagStatus').textContent = `コピーしました（${text.length.toLocaleString()} 文字）`;
  } catch {
    // クリップボードが使えないときは、選んでコピーできるようにテキスト欄に出す
    let box = $('pvDiagText');
    if (!box) {
      box = document.createElement('textarea');
      box.id = 'pvDiagText';
      box.rows = 8;
      box.readOnly = true;
      $('pvDiagStatus').after(box);
    }
    box.value = text;
    box.select();
    $('pvDiagStatus').textContent = 'コピーできなかったので、下の欄の内容を選んでコピーしてください';
  }
});

$('pvDiagClear').addEventListener('click', async () => {
  await chrome.storage.local.remove('pvDiag');
  $('pvDiagText')?.remove();
  $('pvDiagStatus').textContent = '消しました';
  showDiagCount();
});

showDiagCount();
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.pvDiag) showDiagCount();
});

// ---- 意見・不具合の報告（押したときだけ、報告用の情報をコピーして、サポートのページを開く。自動では何も送らない） ----

// 設定画面は自分のタブで開くため、「いま開いているページ」は「なし」になる（ポップアップから報告すると、開いているサイトのドメイン名が入る）
const [reportTab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
const reportInfo = () => collectInfo({ tab: reportTab, blocked: null });
$('reportPreview').value = buildReport(await reportInfo());

for (const [id, url] of [['privacyLink', PRIVACY_URL], ['sourceLink', SOURCE_URL]]) {
  if (!isConfigured(url)) continue;
  $(id).href = url;
  $(id).hidden = false;
  $('reportLinks').hidden = false;
}

for (const button of $('reportButtons').querySelectorAll('[data-kind]')) {
  button.addEventListener('click', async () => {
    const text = buildReport(await reportInfo());
    $('reportPreview').value = text;
    const copied = await copyText(text);
    const status = $('reportStatus');
    status.hidden = false;
    if (!copied) {
      $('reportPreview').select();
      status.textContent = 'コピーできなかったので、上の欄の内容を選んでコピーしてください。';
    } else if (!isConfigured(SUPPORT_URL)) {
      status.textContent = '報告用の情報をコピーしました。サポート窓口の URL が未設定です。';
    } else {
      status.textContent = '報告用の情報をコピーしました。開いたページに貼り付けてください（内容は貼り付ける前に確認できます）';
    }
    if (copied) await openSupport(button.dataset.kind);
  });
}
