// 「要素を選んでブロック」。ポップアップから今のタブに入れられ、クリックした要素を隠すフィルターを作る。
(() => {
  'use strict';
  if (globalThis.__adbanPicker) return;
  globalThis.__adbanPicker = true;

  // ページに見える要素の名前に拡張機能の名前を入れない（カスタム要素の名前にはハイフンが要る）
  const host = document.createElement(`x-${Math.random().toString(36).slice(2, 10).padEnd(8, 'x')}`);
  host.setAttribute(
    'style',
    'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;',
  );
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
<style>
  * { box-sizing: border-box; }
  .box {
    position: fixed; display: none; pointer-events: none;
    border: 2px solid #e5484d; border-radius: 3px; background: rgba(229, 72, 77, 0.18);
    transition: left .06s, top .06s, width .06s, height .06s;
  }
  .panel {
    --bg: #ffffff; --text: #1c1c1f; --muted: #6b6b73; --border: #e4e4e7; --field: #f6f6f7;
    position: fixed; right: 16px; bottom: 16px; width: min(440px, calc(100vw - 32px));
    pointer-events: auto; background: var(--bg); color: var(--text);
    border: 1px solid var(--border); border-radius: 12px; padding: 14px 16px 16px;
    box-shadow: 0 12px 40px rgba(0, 0, 0, .28);
    font: 13px/1.5 system-ui, "Hiragino Sans", "Yu Gothic UI", Meiryo, sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    .panel { --bg: #1f1f23; --text: #ececef; --muted: #a0a0a8; --border: #34343a; --field: #2a2a2f; }
  }
  .head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .title { font-weight: 600; font-size: 14px; flex: 1; }
  .hint { margin: 0; color: var(--muted); }
  .editor[hidden], .hint[hidden] { display: none; }
  input {
    width: 100%; margin: 8px 0 4px; padding: 8px 10px; border-radius: 8px;
    border: 1px solid var(--border); background: var(--field); color: var(--text);
    font: 12px/1.4 ui-monospace, Consolas, monospace;
  }
  input:focus { outline: 2px solid #e5484d; outline-offset: -1px; }
  .count { color: var(--muted); font-size: 12px; min-height: 18px; }
  .count.bad { color: #e5484d; }
  .buttons { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
  .spacer { flex: 1; }
  button {
    font: inherit; padding: 6px 12px; border-radius: 8px; cursor: pointer;
    border: 1px solid var(--border); background: var(--bg); color: var(--text);
  }
  button:hover { background: var(--field); }
  button.primary { background: #e5484d; border-color: #e5484d; color: #fff; font-weight: 600; }
  button.primary:hover { background: #d13d42; }
  button:disabled { opacity: .45; cursor: default; }
  .close { border: none; padding: 2px 8px; font-size: 18px; line-height: 1; color: var(--muted); }
</style>
<div class="box"></div>
<div class="panel" role="dialog" aria-label="要素を選んでブロック">
  <div class="head">
    <div class="title">要素を選んでブロック</div>
    <button class="close" title="終了（Esc）" aria-label="終了">×</button>
  </div>
  <p class="hint">隠したい広告をクリックしてください。Esc で終了します。</p>
  <div class="editor" hidden>
    <input class="selector" spellcheck="false" aria-label="選択子">
    <div class="count"></div>
    <div class="buttons">
      <button class="parent">親要素へ</button>
      <button class="retry">選び直す</button>
      <span class="spacer"></span>
      <button class="ok primary">ブロック</button>
    </div>
  </div>
</div>`;
  document.documentElement.appendChild(host);

  const $ = (selector) => root.querySelector(selector);
  const box = $('.box');
  const hint = $('.hint');
  const editor = $('.editor');
  const input = $('.selector');
  const count = $('.count');
  const okButton = $('.ok');

  let hovered = null;
  let picked = null;

  const ours = (event) => event.composedPath().includes(host);

  const highlight = (el) => {
    if (!el?.isConnected) {
      box.style.display = 'none';
      return;
    }
    const r = el.getBoundingClientRect();
    Object.assign(box.style, {
      display: 'block',
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    });
  };

  // ---- 選択子を作る ----

  // 数字が続く名前は表示のたびに変わることが多いので使わない
  const stable = (name) => name && name.length <= 40 && !/\d{3,}/.test(name);

  const partFor = (el) => {
    let part = CSS.escape(el.localName);
    const classes = [...el.classList].filter(stable).slice(0, 3);
    part += classes.map((c) => `.${CSS.escape(c)}`).join('');
    const parent = el.parentElement;
    if (parent) {
      const siblings = [...parent.children].filter((c) => c.matches(part));
      if (siblings.length > 1) part += `:nth-of-type(${[...parent.children].filter((c) => c.localName === el.localName).indexOf(el) + 1})`;
    }
    return part;
  };

  const selectorFor = (el) => {
    const parts = [];
    for (let node = el, depth = 0; node && depth < 8; node = node.parentElement, depth++) {
      if (node === document.documentElement || node === document.body) break;
      if (stable(node.id)) {
        parts.unshift(`#${CSS.escape(node.id)}`);
      } else {
        parts.unshift(partFor(node));
      }
      const selector = parts.join(' > ');
      if (parts[0].startsWith('#') || document.querySelectorAll(selector).length === 1) return selector;
    }
    return parts.join(' > ');
  };

  // ---- 操作 ----

  const matchCount = () => {
    try {
      return document.querySelectorAll(input.value.trim()).length;
    } catch {
      return -1;
    }
  };

  const update = () => {
    const n = matchCount();
    count.textContent = n < 0 ? '選択子の書き方が正しくありません' : `${n} 個の要素が一致`;
    count.classList.toggle('bad', n <= 0);
    okButton.disabled = n <= 0;
  };

  const select = (el) => {
    picked = el;
    input.value = selectorFor(el);
    hint.hidden = true;
    editor.hidden = false;
    highlight(el);
    update();
  };

  const restart = () => {
    picked = null;
    editor.hidden = true;
    hint.hidden = false;
    highlight(hovered);
  };

  const onMove = (event) => {
    if (picked || ours(event)) return;
    const el = document.elementFromPoint(event.clientX, event.clientY);
    if (!el || el === host || el === document.documentElement || el === document.body) return;
    hovered = el;
    highlight(el);
  };

  // ページ側のクリック処理（広告のリンクなど）を動かさない
  const swallow = (event) => {
    if (ours(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  const onClick = (event) => {
    if (ours(event)) return;
    swallow(event);
    if (!picked && hovered) select(hovered);
  };

  const onKey = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    }
  };

  const onViewport = () => highlight(picked ?? hovered);

  const SWALLOWED = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu'];

  function close() {
    window.removeEventListener('mousemove', onMove, true);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', onViewport, true);
    window.removeEventListener('resize', onViewport, true);
    for (const type of SWALLOWED) window.removeEventListener(type, swallow, true);
    host.remove();
    delete globalThis.__adbanPicker;
  }

  window.addEventListener('mousemove', onMove, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', onViewport, true);
  window.addEventListener('resize', onViewport, true);
  for (const type of SWALLOWED) window.addEventListener(type, swallow, true);

  // パネルでの入力がページのショートカットキーとして扱われないようにする
  for (const type of ['keydown', 'keyup', 'keypress']) {
    root.addEventListener(type, (event) => {
      if (event.key !== 'Escape') event.stopPropagation();
    });
  }

  input.addEventListener('input', update);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !okButton.disabled) okButton.click();
  });
  $('.close').addEventListener('click', close);
  $('.retry').addEventListener('click', restart);
  $('.parent').addEventListener('click', () => {
    const parent = picked?.parentElement;
    if (parent && parent !== document.body && parent !== document.documentElement) select(parent);
  });
  // 画面を覆う警告（「広告ブロッカーを無効にしてください」など）は、ページのスクロールも止めていることが多い。
  // そういう要素を消すときは、スクロールも元に戻す。
  const coversScreen = (el) => {
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      if (getComputedStyle(e).position !== 'fixed') continue;
      const r = el.getBoundingClientRect();
      return r.width * r.height >= innerWidth * innerHeight * 0.3;
    }
    return false;
  };
  const scrollLocked = () =>
    [document.documentElement, document.body].some((e) => e && /hidden|clip/.test(getComputedStyle(e).overflowY));
  const shouldUnlockScroll = (selector) => {
    try {
      return scrollLocked() && [...document.querySelectorAll(selector)].some(coversScreen);
    } catch {
      return false;
    }
  };

  okButton.addEventListener('click', async () => {
    okButton.disabled = true;
    let result;
    try {
      const selector = input.value.trim();
      result = await chrome.runtime.sendMessage({ type: 'picker:add', selector, unlockScroll: shouldUnlockScroll(selector) });
    } catch (e) {
      result = { ok: false, error: e.message };
    }
    if (result?.ok) {
      close();
    } else {
      count.textContent = result?.error ?? '追加できませんでした';
      count.classList.add('bad');
      okButton.disabled = false;
    }
  });
})();
