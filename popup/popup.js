import { ALLOW_ID_BASE, CUSTOM_ID_BASE } from '../lib/filters.js';
import { hostChain, hostOf, isListed, siteKey } from '../lib/hosts.js';
import { SUPPORT_URL, buildReport, collectInfo, copyText, isConfigured, openSupport } from '../lib/support.js';

const $ = (id) => document.getElementById(id);

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
const host = hostOf(tab?.url ?? '');
let blocked = null; // このタブで止めた件数（問題の報告に入れる）
let { enabled = true, allowlist = [] } = await chrome.storage.local.get(['enabled', 'allowlist']);

function render() {
  const siteOn = !!host && !isListed(allowlist, host);
  document.body.classList.toggle('off', !enabled);
  $('enabled').checked = enabled;
  $('host').textContent = host || 'このページでは使えません';
  $('siteEnabled').checked = siteOn;
  $('siteEnabled').disabled = !host || !enabled;
  $('pick').disabled = !host || !enabled || !siteOn;
}

async function countBlocked() {
  if (!host || !tab?.id) return null;
  try {
    const { rulesMatchedInfo } = await chrome.declarativeNetRequest.getMatchedRules({ tabId: tab.id });
    const dynamic = chrome.declarativeNetRequest.DYNAMIC_RULESET_ID;
    // 許可ルールと、拡張機能が内部で使う動的ルールは数えない
    return rulesMatchedInfo.filter(
      ({ rule }) => rule.ruleId < ALLOW_ID_BASE && !(rule.rulesetId === dynamic && rule.ruleId < CUSTOM_ID_BASE),
    ).length;
  } catch {
    return null;
  }
}

const showReload = () => {
  $('notice').hidden = !host;
};

const showError = (message) => {
  $('error').textContent = message;
  $('error').hidden = false;
};

$('enabled').addEventListener('change', async (event) => {
  enabled = event.target.checked;
  await chrome.storage.local.set({ enabled });
  render();
  showReload();
});

$('siteEnabled').addEventListener('change', async (event) => {
  if (event.target.checked) {
    const chain = new Set(hostChain(host));
    allowlist = allowlist.filter((d) => !chain.has(d));
  } else {
    allowlist = [...new Set([...allowlist, siteKey(host)])];
  }
  await chrome.storage.local.set({ allowlist });
  render();
  showReload();
});

$('reload').addEventListener('click', () => {
  chrome.tabs.reload(tab.id);
  window.close();
});

$('pick').addEventListener('click', async () => {
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/picker.js'] });
    window.close();
  } catch {
    showError('このページでは要素を選べません。');
  }
});

$('options').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

render();
countBlocked().then((count) => {
  blocked = count;
  $('count').textContent = count ?? '–';
});

// ---- 問題を報告（押したときだけ、報告用の情報をコピーして、サポートのページを開く。自動では何も送らない） ----

const showReportMessage = (message) => {
  $('reportMsg').textContent = message;
  $('reportMsg').hidden = !message;
};

$('reportToggle').addEventListener('click', () => {
  const open = $('reportMenu').hidden;
  $('reportMenu').hidden = !open;
  $('reportToggle').setAttribute('aria-expanded', String(open));
});

for (const button of $('reportMenu').querySelectorAll('[data-kind]')) {
  button.addEventListener('click', async () => {
    const kind = button.dataset.kind;
    $('reportMenu').hidden = true;
    $('reportToggle').setAttribute('aria-expanded', 'false');
    const text = buildReport(await collectInfo({ tab, blocked }));
    // ポップアップはタブを開くと閉じるので、コピーが終わってからタブを開く
    const copied = await copyText(text);
    if (!copied) {
      // クリップボードが使えないときは、選んでコピーできる欄に出す（タブは開かない。開くとこの欄が閉じてしまう）
      $('reportText').value = text;
      $('reportText').hidden = false;
      $('reportText').select();
      $('reportOpen').dataset.kind = kind;
      $('reportOpen').hidden = !isConfigured(SUPPORT_URL);
      showReportMessage('コピーできなかったので、下の欄の内容を選んでコピーしてください。そのあと、サポートのページに貼り付けてください。');
      return;
    }
    if (!isConfigured(SUPPORT_URL)) {
      showReportMessage('報告用の情報をコピーしました。サポート窓口の URL が未設定です。');
      return;
    }
    showReportMessage('報告用の情報をコピーしました。開いたページに貼り付けてください（内容は貼り付ける前に確認できます）');
    await openSupport(kind);
  });
}

$('reportOpen').addEventListener('click', () => openSupport($('reportOpen').dataset.kind));
