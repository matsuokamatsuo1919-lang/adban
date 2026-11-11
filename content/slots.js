// 広告の「枠」と「記事広告」を、見た目と構造から判断してたたむ（隠す）。通信やフィルターリストでは止められないもの向け。
//   1. 空の広告枠: 広告の中身が消えたあとに「Advertisement」「広告」「Sponsored」の札だけが残った、余白の多い枠
//   2. 記事広告: 画像とリンクを持つカードの中に「PR」「広告」「スポンサード」などの札があるもの
// 誤爆（正規の内容を隠すこと）が最悪なので、条件はすべて保守的にしてある。疑わしいときは隠さない。
//
// 軽さのために:
//   ・最上位のページだけで動く（manifest の all_frames: false）。オフの設定・許可リストのサイトでは何もしない
//   ・最初に DOM 全体のテキストを走査するのは 1 回だけ（札らしい文字列を探す）。札が 1 つもなければ MutationObserver も作らない
//   ・そのあとは、追加されたノードだけを 300ms のデバウンスをかけて調べる
//   ・1 回の処理は BUDGET_MS で区切り、超えたら次のフレームに回す（content/procedural.js と同じ方式）
(() => {
  'use strict';

  // ---- 札の判定に使う、DOM に依存しない関数 ----
  // tools/slots.test.mjs が globalThis.__adbanExport 経由で取り出して試す（ページ側からは設定できない）。

  // 札として認める文言（前後の空白・括弧・記号を除き、大文字小文字を区別しない、ちょうど一致するもの）
  const AD_LABEL_TEXTS = [
    'advertisement', 'advertising', 'ad', 'ads', '広告', '広告枠', 'スポンサー', 'スポンサード', 'スポンサードリンク',
    'スポンサーリンク', 'sponsored', 'sponsored content', 'sponsor', 'promoted', 'promotion', 'プロモーション',
    'pr', '【pr】', '［pr］', '[pr]', '(pr)', '（pr）', 'pr記事', '広告記事', 'タイアップ', 'タイアップ記事', '提供',
  ];
  const MAX_LABEL_CHARS = 20; // 札の文字数の上限（'sponsored content' が入る長さ。ふつうの札は 12 文字以内）

  // 全角を半角にそろえ、小文字にし、前後の空白・括弧・記号（文字と数字以外）を落とす。例: 「【PR】」→ 'pr'、「Ａｄ ▼」→ 'ad'
  const normalizeLabel = (text) =>
    typeof text === 'string'
      ? text
          .normalize('NFKC')
          .toLowerCase()
          .replace(/\s+/g, ' ')
          .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
      : '';

  const AD_LABELS = new Set(AD_LABEL_TEXTS.map(normalizeLabel));

  // 広告の札の文言か（短い文字列がちょうど一致するときだけ。「広告について」「PR会社」「Ad blocking」は対象外）
  const isAdLabel = (text) => {
    if (typeof text !== 'string') return false;
    const t = text.trim();
    return t.length > 0 && t.length <= MAX_LABEL_CHARS && AD_LABELS.has(normalizeLabel(t));
  };

  // 日付・数字・単位だけの短い文字列か（カードの日付や件数。「ほかの札」には数えない）
  const DATELIKE_RE = /^[\d\s:：/／.\-－年月日時分秒前円¥￥,，%％()（）+＋]+$/;
  // カテゴリ名のような短い札か（広告の札ではない 1〜10 文字の文字列。日付・数字だけのものは除く）
  const isBadgeText = (text) => {
    if (typeof text !== 'string') return false;
    const t = text.trim();
    return t.length > 0 && t.length <= 10 && !DATELIKE_RE.test(t) && !isAdLabel(t);
  };

  // class 名に「PR」の札を示す語があるか。文字ではなく画像で「PR」を描く札（価格.com の c-feed_visual-pr など）用。
  // 'pr' そのもの、または '-pr' '_pr' で終わるもの（'pr-4' のような余白の指定は含めない）、'sponsored' 系
  const PR_CLASS_RE = /^(?:pr|sponsored)$|[-_](?:pr|sponsored)$/;
  const hasPrClass = (cls) =>
    typeof cls === 'string' && cls.length <= 300 && cls.toLowerCase().split(/\s+/).some((t) => PR_CLASS_RE.test(t));

  if (globalThis.__adbanExport) {
    Object.assign(globalThis.__adbanExport, { AD_LABEL_TEXTS, normalizeLabel, isAdLabel, isBadgeText, hasPrClass });
    return;
  }

  if (globalThis.__adbanSlots) return;
  // 処理の回数と時間（計測用。isolated world の中にあるので、ページからは見えない）
  const stats = { passes: 0, slices: 0, spentMs: 0, maxSliceMs: 0, labels: 0, hiddenSlots: 0, hiddenCards: 0, scans: 0 };
  globalThis.__adbanSlots = stats;

  const BUDGET_MS = 8; // 1 回の処理に使ってよい時間
  const DEBOUNCE_MS = 300; // 変化を受けてから調べるまでの間隔
  const WAIT_MS = 3000; // 札を見つけてから、広告の中身が入るのを待つ時間
  const MAX_LABEL_FONT = 18; // 札の文字の大きさの上限（px）
  const MAX_LABELS = 100; // ページ上の札の数がこれ以上なら、広告ではなく分類ラベルとみなして何もしない
  const MAX_CARDS = 30; // 1 ページで隠す記事広告の数の上限
  const MAX_SLOTS = 60; // 1 ページでたたむ空の枠の数の上限
  const MAX_PENDING = 1000; // 追加されたノードのうち、調べ直しの対象にする数の上限
  const SLOT_MAX_VIEW = 0.6; // 枠が画面のこれ以上を占めるなら、主要な内容かもしれないのでたたまない
  const CARD_MAX_VIEW = 0.4; // カードが画面のこれ以上を占めるなら、カードではないので隠さない
  const CARD_MAX_TEXT = 200;
  const CARD_MAX_ELEMENTS = 150;
  const MEDIA_SELECTOR = 'img,picture,iframe,video,canvas,svg,object,embed';

  // 札として認めない場所（見出し・ボタン・入力欄・メニューの中の語は、広告の札ではない）
  const EXCLUDED_ANCESTOR =
    'h1,h2,h3,h4,h5,h6,[role=heading],button,[role=button],label,input,textarea,select,option,pre,code,' +
    'nav,[role=navigation],[role=menu],[role=menuitem],[role=tab],[contenteditable=""],[contenteditable=true]';
  // 記事広告のカードを探すとき、ここに入ったら（内側にカードがなければ）あきらめる境界
  const CARD_STOP_TAGS = new Set(['BODY', 'HTML', 'MAIN', 'UL', 'OL', 'DL', 'TABLE', 'TBODY', 'THEAD', 'SECTION', 'ASIDE', 'NAV', 'HEADER', 'FOOTER', 'FORM']);
  const CARD_TAGS = new Set(['A', 'LI', 'ARTICLE', 'DIV']);
  // 空の枠として隠してはいけない要素
  const SLOT_STOP_TAGS = new Set(['BODY', 'HTML', 'MAIN', 'UL', 'OL', 'DL', 'TABLE', 'TBODY', 'THEAD', 'TR', 'FORM', 'NAV', 'HEADER', 'FOOTER', 'ARTICLE', 'SECTION']);

  const send = (message) => {
    try {
      return chrome.runtime.sendMessage(message).catch(() => null);
    } catch {
      return Promise.resolve(null); // 拡張機能が再読み込みされた後など
    }
  };

  const nextFrame = (fn) => {
    let fired = false;
    const go = () => {
      if (fired) return;
      fired = true;
      fn();
    };
    requestAnimationFrame(go);
    setTimeout(go, 100); // 隠れたタブでは requestAnimationFrame が呼ばれない
  };

  // ---- DOM の小さな道具 ----

  const isVisible = (el) => {
    try {
      return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    } catch {
      return false;
    }
  };

  const rectOf = (el) => el.getBoundingClientRect();

  // 子ノードのうち、直接のテキストの長さ（子要素のテキストは含まない）
  const ownTextLength = (el) => {
    let n = 0;
    for (const c of el.childNodes) if (c.nodeType === 3) n += c.data.trim().length;
    return n;
  };

  const hasBackgroundImage = (el) => {
    try {
      const bg = getComputedStyle(el).backgroundImage;
      return !!bg && bg !== 'none';
    } catch {
      return false;
    }
  };

  // 20px 四方以上で見えている画像・iframe などか（img は読み込み前でも、枠が確保されていれば中身があるとみなす）
  const isVisibleMedia = (el) => {
    const r = rectOf(el);
    return r.width >= 20 && r.height >= 20 && isVisible(el);
  };

  // root の中に（skip を除いて）見える画像・背景画像つきの要素があるか。要素数が多ければ調べずに「ある」とする側に倒す
  const hasVisibleContent = (root, skip, selector = MEDIA_SELECTOR) => {
    const all = root.querySelectorAll('*');
    if (all.length > CARD_MAX_ELEMENTS) return true;
    for (const m of root.querySelectorAll(selector)) {
      if (skip && skip.contains(m)) continue;
      if (isVisibleMedia(m)) return true;
    }
    const rootRect = rectOf(root);
    if (rootRect.width >= 20 && rootRect.height >= 20 && hasBackgroundImage(root)) return true;
    for (const e of all) {
      if (skip && skip.contains(e)) continue;
      if (hasBackgroundImage(e) || e.hasAttribute('data-original') || e.hasAttribute('data-bg')) {
        const r = rectOf(e);
        if (r.width >= 20 && r.height >= 20) return true;
      }
    }
    return false;
  };

  const viewArea = () => Math.max(1, innerWidth * innerHeight);

  // ---- 設定とフラグ ----

  const opts = { slots: true, promo: true };
  let disabled = false;
  const seenLabels = new WeakSet(); // 数えた札
  let labelCount = 0;
  const tracked = new Map(); // 札の要素 → { seen, dueSlot, duePromo, promoTry, slotDone, promoDone }
  const hiddenCards = new Map(); // 隠した記事広告（元の display を覚える）
  const hiddenSlots = new Map(); // たたんだ空の枠（元の display と、そのときの中身の量を覚える）

  // ---- 札の候補を見つける ----

  // テキストノードから、札の候補（要素）を返す。条件に合わなければ null
  const labelFromText = (textNode) => {
    const el = textNode.parentElement;
    if (!el || seenLabels.has(el)) return null;
    const data = textNode.data;
    if (data.length > 40) return null;
    const t = data.trim();
    if (!t || !isAdLabel(t)) return null;
    const tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') return null;
    // 要素全体のテキストも札と同じであること（「広告」＋ほかの文字が混じるものは対象にしない）
    if (el.textContent.length > 40 || normalizeLabel(el.textContent) !== normalizeLabel(t)) return null;
    if (el.closest(EXCLUDED_ANCESTOR)) return null;
    // 記事の本文の段落そのもの
    if (tag === 'P' && el.closest('main,article,[role=main]')) return null;
    if (!isVisible(el)) return null;
    const r = rectOf(el);
    if (r.width < 1 || r.height < 1) return null;
    const style = getComputedStyle(el);
    if (parseFloat(style.fontSize) > MAX_LABEL_FONT) return null;
    const anchor = el.closest('a');
    // リンクの中の語は、サムネイル（画像）を持つリンクの上に重ねた札のときだけ認める（記事の中のリンク・目次の語は除く）
    const imageLink = !!anchor && !!anchor.querySelector('img,picture') && hasVisibleContent(anchor, null, 'img,picture');
    if (anchor && !imageLink) return null;
    // 文章の途中の語（インラインで、すぐ隣に本文がある）は、本文中の語とみなす
    if (!imageLink && style.display === 'inline') {
      const parent = el.parentElement;
      if (parent && ownTextLength(parent) > 12) return null;
      const grand = parent?.parentElement;
      if (parent && grand && getComputedStyle(parent).display === 'inline' && ownTextLength(grand) > 12) return null;
    }
    return { el, imageLink };
  };

  // 要素そのものが札の候補か（class 名が PR を示すもの、alt が広告の札の画像）。記事広告のカードを探すためだけに使う
  const labelFromElement = (el) => {
    if (seenLabels.has(el) || el.tagName === 'BODY' || el.tagName === 'HTML') return null;
    let kind = null;
    if (el.tagName === 'IMG') {
      if (isAdLabel(el.getAttribute('alt') ?? '')) kind = 'img';
    } else {
      const cls = el.getAttribute('class');
      if (cls && hasPrClass(cls)) kind = 'class';
    }
    if (!kind) return null;
    if (el.closest(EXCLUDED_ANCESTOR) || !isVisible(el)) return null;
    const r = rectOf(el);
    if (r.width < 1 || r.height < 1) return null;
    if (kind === 'img' && (r.width > 120 || r.height > 60)) return null; // 札の画像は小さい
    let selfImage = false;
    if (kind === 'class' && r.width >= 40 && r.height >= 40) {
      // 札の class を持つ要素そのものが、画像（背景・遅延読み込みの指定・中の img）を持つサムネイルか
      selfImage =
        el.hasAttribute('data-original') || el.hasAttribute('data-bg') || hasBackgroundImage(el) ||
        (el.querySelector('img,picture') && hasVisibleContent(el, null, 'img,picture'));
    }
    return { el, imageLink: false, kind, selfImage };
  };

  // root の下のテキストノードを走査する（root 自身がテキストノードならそれだけ）。時間が来たら途中で返し、続きを持つ
  let scanQueue = []; // これから走査するノード
  let walker = null;
  let scanning = null; // いま走査中の root

  const foundLabel = (found) => {
    seenLabels.add(found.el);
    labelCount++;
    stats.labels = labelCount;
    if (labelCount >= MAX_LABELS) {
      disable(); // 札が多すぎるページは、広告ではなく記事の分類ラベルだらけの可能性が高い
      return false;
    }
    const now = Date.now();
    tracked.set(found.el, {
      seen: now,
      duePromo: now,
      dueSlot: now + WAIT_MS,
      promoTry: 0,
      slotDone: !opts.slots || found.imageLink || found.kind !== undefined,
      promoDone: !opts.promo,
      kind: found.kind,
      selfImage: !!found.selfImage,
    });
    return true;
  };

  // 走査の続きを deadline まで進める。終わったら true
  const scanSome = (deadline) => {
    let n = 0;
    for (;;) {
      if (disabled) return true;
      if (!walker) {
        const root = scanQueue.shift();
        if (!root) return true;
        if (!root.isConnected) continue;
        if (root.nodeType === 3) {
          const found = labelFromText(root);
          if (found && !foundLabel(found)) return true;
          continue;
        }
        if (opts.promo) {
          const found = labelFromElement(root);
          if (found && !foundLabel(found)) return true;
        }
        scanning = root;
        walker = document.createTreeWalker(root, opts.promo ? NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT : NodeFilter.SHOW_TEXT);
      }
      const node = walker.nextNode();
      if (!node) {
        walker = null;
        scanning = null;
        continue;
      }
      if (node.nodeType === 1) {
        const found = labelFromElement(node);
        if (found && !foundLabel(found)) return true;
      } else if (node.data.length <= 40) {
        const found = labelFromText(node);
        if (found && !foundLabel(found)) return true;
      }
      if (++n % 64 === 0 && performance.now() > deadline) return false;
    }
  };

  // ---- 隠す・戻す ----

  const hide = (el, store, extra) => {
    store.set(el, {
      value: el.style.getPropertyValue('display'),
      priority: el.style.getPropertyPriority('display'),
      ...extra,
    });
    el.style.setProperty('display', 'none', 'important');
  };

  const restore = (el, store) => {
    const saved = store.get(el);
    store.delete(el);
    if (!saved) return;
    if (saved.value) el.style.setProperty('display', saved.value, saved.priority);
    else el.style.removeProperty('display');
  };

  // ---- 空の広告枠 ----

  // 札以外に見える内容がない枠か
  const isEmptyFrame = (frame, label) => {
    if (SLOT_STOP_TAGS.has(frame.tagName) || frame.matches('[role=main],[role=navigation],[role=banner]')) return false;
    if (frame.querySelectorAll('*').length > 40) return false;
    // 入力欄・操作部品・動画・音声などがあるものは内容がある
    if (frame.querySelector('input,textarea,select,button,form,video,audio,[contenteditable]')) return false;
    // 札以外のテキストが 20 文字以下
    const rest = frame.textContent.replace(/\s+/g, '').replace(label.textContent.replace(/\s+/g, ''), '');
    if (rest.length > 20) return false;
    // 文字のあるリンクは内容がある
    for (const a of frame.querySelectorAll('a[href]')) if (a.textContent.trim()) return false;
    // 見える画像・iframe・背景画像などがあれば内容がある（札そのものは除く）
    if (hasVisibleContent(frame, label)) return false;
    return true;
  };

  const mediaCount = (el) => el.querySelectorAll(MEDIA_SELECTOR).length;

  const trySlot = (label) => {
    if (hiddenSlots.size >= MAX_SLOTS) return;
    let frame = null;
    let node = label;
    for (let i = 0; i < 3; i++) {
      node = node.parentElement;
      if (!node || !isEmptyFrame(node, label)) break;
      frame = node; // 親・祖父母のうち、内容がない最も外側
    }
    if (!frame) return;
    const fr = rectOf(frame);
    const lr = rectOf(label);
    if (fr.width < 1 || fr.height - lr.height < 24) return; // 札だけの枠（余白がない）はそのまま
    if ((fr.width * fr.height) / viewArea() >= SLOT_MAX_VIEW) return; // 画面の大部分を占める枠は主要な内容かもしれない
    if (hiddenSlots.has(frame)) return;
    hide(frame, hiddenSlots, { media: mediaCount(frame), text: frame.textContent.trim().length });
    stats.hiddenSlots = hiddenSlots.size;
  };

  // たたんだ枠に、あとから広告の中身（画像・iframe など、または文字）が入ったら戻す
  const checkRestore = () => {
    for (const [frame, saved] of hiddenSlots) {
      if (!frame.isConnected) {
        hiddenSlots.delete(frame);
        continue;
      }
      if (mediaCount(frame) > saved.media || frame.textContent.trim().length > saved.text + 20) {
        restore(frame, hiddenSlots);
        stats.hiddenSlots = hiddenSlots.size;
      }
    }
  };

  // ---- 記事広告 ----

  // カードとして十分小さく、文字が少ないか（ここを超えたら、外側もすべて超える）
  const cardSized = (node) => {
    if (node.querySelectorAll('*').length > CARD_MAX_ELEMENTS) return false;
    if (node.textContent.trim().length > CARD_MAX_TEXT) return false;
    const r = rectOf(node);
    return (r.width * r.height) / viewArea() < CARD_MAX_VIEW;
  };

  const hasRealLink = (node) => {
    const isReal = (a) => {
      const href = a.getAttribute('href') ?? '';
      return href !== '' && !href.startsWith('#') && !/^javascript:/i.test(href);
    };
    if (node.tagName === 'A' && isReal(node)) return true;
    for (const a of node.querySelectorAll('a[href]')) if (isReal(a)) return true;
    return false;
  };

  // 同じ種類の兄弟が並んでいる「一覧の 1 項目」か
  const isListItem = (node) => {
    if (node.tagName === 'LI') return true;
    const parent = node.parentElement;
    if (!parent) return false;
    let same = 0;
    for (const c of parent.children) if (c.tagName === node.tagName && ++same >= 2) return true;
    return false;
  };

  // 広告かどうか曖昧なカードか（広告の札のほかに、カテゴリ名のような短い札が複数ある・入力欄がある・見出しの大きな文字がある）
  const isAmbiguousCard = (card) => {
    if (card.querySelector('h1,input,textarea,select,form,video,iframe')) return true;
    let badges = 0;
    for (const e of card.querySelectorAll('*')) {
      if (e.childElementCount > 0) continue;
      if (!isBadgeText(e.textContent) || e.closest('h1,h2,h3,h4,h5,h6')) continue;
      if (++badges >= 2) return true;
    }
    return false;
  };

  // 札から、記事広告のカードを決める。決められなければ null
  const findCard = (label, kind, selfImage) => {
    if (label.closest('nav,header,footer,[role=navigation],[role=banner],[role=contentinfo]')) return null;
    let innermost = null;
    // class が札のものは、その要素自身（li.is-pr など）がカードのこともある。文字の札は親から探す
    let node = kind === 'class' ? label : label.parentElement;
    for (let i = 0; i < 8 && node; i++, node = node.parentElement) {
      if (CARD_STOP_TAGS.has(node.tagName)) return null;
      if (!cardSized(node)) return null; // 大きすぎる。外側もすべて大きい
      if (!CARD_TAGS.has(node.tagName)) continue;
      if ((selfImage || hasVisibleContent(node, label, 'img,picture,video')) && hasRealLink(node)) {
        innermost = node;
        break;
      }
    }
    if (!innermost) return null;
    // 一覧の項目（li・同じ種類の兄弟が並ぶ要素）が 3 階層以内の外側にあれば、サムネイルだけでなく項目ごと隠す
    let card = innermost;
    let up = innermost;
    for (let i = 0; i < 3; i++) {
      up = up.parentElement;
      if (!up || CARD_STOP_TAGS.has(up.tagName) && up.tagName !== 'LI') break;
      if (!CARD_TAGS.has(up.tagName) || !cardSized(up)) break;
      if (up.querySelector('li,article') && up.tagName !== 'LI' && up.tagName !== 'ARTICLE') break;
      if (up.querySelectorAll('a[href]').length > 5) break;
      if (isListItem(up)) {
        card = up;
        break;
      }
      if (up.childElementCount !== 1) break; // 兄弟がいるなら、そこで止める
      card = up;
    }
    if (card === label || CARD_STOP_TAGS.has(card.tagName) && card.tagName !== 'LI') return null;
    if (isAmbiguousCard(card)) return null;
    return card;
  };

  const tryPromo = (label, entry) => {
    if (hiddenCards.size >= MAX_CARDS) return false;
    const card = findCard(label, entry.kind, entry.selfImage);
    if (!card || hiddenCards.has(card)) return false;
    hide(card, hiddenCards);
    stats.hiddenCards = hiddenCards.size;
    return true;
  };

  // ---- 評価の流れ ----

  const evaluate = (label, entry, now) => {
    if (!label.isConnected) {
      tracked.delete(label);
      return;
    }
    if (!entry.promoDone && now >= entry.duePromo) {
      let hidden = false;
      try {
        hidden = isVisible(label) && tryPromo(label, entry);
      } catch {
        // 1 つの札の失敗はほかに影響しない
      }
      if (hidden) {
        entry.promoDone = true;
        entry.slotDone = true;
      } else if (++entry.promoTry >= 2) {
        entry.promoDone = true; // 画像の読み込みを待って 1 回やり直した。もう調べない
      } else {
        entry.duePromo = entry.seen + WAIT_MS;
      }
    }
    if (!entry.slotDone && now >= entry.dueSlot) {
      entry.slotDone = true;
      try {
        if (isVisible(label)) trySlot(label);
      } catch {
        // 同上
      }
    }
    if (entry.promoDone && entry.slotDone) tracked.delete(label);
  };

  let pass = null;
  let rerun = false;
  let timer = 0;
  let observer = null;
  let retried = false;
  const pending = new Set(); // 追加されたノード（次の処理で走査する）

  const nextDueIn = () => {
    let due = Infinity;
    for (const e of tracked.values()) {
      if (!e.promoDone) due = Math.min(due, e.duePromo);
      if (!e.slotDone) due = Math.min(due, e.dueSlot);
    }
    return due === Infinity ? null : Math.max(50, due - Date.now());
  };

  let timerAt = 0;
  const schedule = (wait) => {
    if (disabled) return;
    clearTimeout(timer);
    timerAt = Date.now() + wait;
    timer = setTimeout(startPass, wait);
  };

  // 変化を受けたときの予約。すでに DEBOUNCE_MS 以内の予約があれば延ばさない（絶え間なく変わるページでも、調べ直しが飢えないように）
  const kick = () => {
    if (timer && timerAt - Date.now() <= DEBOUNCE_MS && timerAt >= Date.now()) return;
    schedule(DEBOUNCE_MS);
  };

  const finishPass = () => {
    pass = null;
    if (disabled) return;
    if (hiddenSlots.size) checkRestore();
    if (labelCount > 0) {
      if (!observer) startObserver();
    } else if (!retried) {
      // 最初の走査で札が 1 つもなければ、MutationObserver は作らない。広告が少し遅れて入るページのために、3 秒後に 1 回だけ見直す
      retried = true;
      setTimeout(() => {
        if (disabled || !document.body) return;
        stats.scans++;
        scanQueue.push(document.body);
        startPass();
      }, WAIT_MS);
      return;
    }
    if (rerun) {
      rerun = false;
      schedule(DEBOUNCE_MS);
      return;
    }
    const wait = nextDueIn();
    if (wait !== null) schedule(wait);
  };

  const runSlice = () => {
    const begin = performance.now();
    const deadline = begin + BUDGET_MS;
    let finished = scanSome(deadline);
    if (finished && !disabled) {
      const now = Date.now();
      for (const [label, entry] of [...tracked]) {
        if (performance.now() > deadline) {
          finished = false;
          break;
        }
        if ((!entry.promoDone && now >= entry.duePromo) || (!entry.slotDone && now >= entry.dueSlot) || !label.isConnected) {
          evaluate(label, entry, now);
        }
      }
    }
    const took = performance.now() - begin;
    stats.slices++;
    stats.spentMs += took;
    if (took > stats.maxSliceMs) stats.maxSliceMs = took;
    if (disabled) {
      pass = null;
      return;
    }
    if (!finished) {
      nextFrame(runSlice);
      return;
    }
    finishPass();
  };

  const startPass = () => {
    timer = 0;
    if (disabled) return;
    if (pass) {
      rerun = true;
      return;
    }
    pass = {};
    stats.passes++;
    for (const n of pending) scanQueue.push(n);
    pending.clear();
    runSlice();
  };

  const startObserver = () => {
    observer = new MutationObserver((records) => {
      let changed = false;
      for (const rec of records) {
        for (const n of rec.addedNodes) {
          if ((n.nodeType === 1 || n.nodeType === 3) && pending.size < MAX_PENDING) pending.add(n);
        }
        changed = true;
      }
      if (changed) kick();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  };

  // 札が多すぎる・設定が合わないなどで、これ以上何もしない。隠したものは元に戻す
  function disable() {
    disabled = true;
    clearTimeout(timer);
    observer?.disconnect();
    observer = null;
    pending.clear();
    tracked.clear();
    scanQueue = [];
    for (const el of [...hiddenCards.keys()]) restore(el, hiddenCards);
    for (const el of [...hiddenSlots.keys()]) restore(el, hiddenSlots);
    stats.hiddenSlots = 0;
    stats.hiddenCards = 0;
  }

  // ---- 開始 ----

  send({ type: 'page:init' }).then((state) => {
    if (!state?.active) return;
    opts.slots = state.collapseSlots !== false;
    opts.promo = state.collapsePromo !== false;
    if (!opts.slots && !opts.promo) return;
    if (!document.body) return;
    stats.scans++;
    scanQueue.push(document.body);
    startPass();
  });
})();
