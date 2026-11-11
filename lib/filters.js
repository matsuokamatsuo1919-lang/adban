// Adblock Plus 形式（uBlock Origin・AdGuard の拡張も一部）のフィルターを読み、
// declarativeNetRequest のルールと、要素隠し・スクリプレット用のデータに変換する。
// 拡張機能の service worker（自分で追加したフィルター）と tools/build-filters.mjs（配布リスト）の両方が使う。

import { ENTITY_TLDS, MAX_ENTITY_DOMAINS } from './entity-tlds.js';
import { redirectPath } from './resources.js';

/**
 * ルールの優先度。数字が大きいほど強い。
 * 同じ優先度なら allow が redirect に勝つので、例外（@@）は偽物への差し替えより優先される。
 */
export const PRIORITY = { block: 1, allow: 2, redirect: 2, important: 3 };

// ルール ID の割り当て。ポップアップでブロック件数を数えるときに、許可ルールと拡張機能が内部で使うルールを除くため。
//   静的ルール: ブロック 1〜, 許可 ALLOW_ID_BASE〜
//   動的ルール: 内部用 1〜999, 自分で追加したブロック CUSTOM_ID_BASE〜, 許可 ALLOW_ID_BASE〜
export const ALLOW_ID_BASE = 500000;
export const CUSTOM_ID_BASE = 1000;

// 種類オプション → declarativeNetRequest の resourceTypes。null は対応する種類がないもの。
const TYPE_MAP = {
  script: 'script',
  image: 'image',
  stylesheet: 'stylesheet',
  css: 'stylesheet',
  object: 'object',
  'object-subrequest': 'object',
  xmlhttprequest: 'xmlhttprequest',
  xhr: 'xmlhttprequest',
  subdocument: 'sub_frame',
  frame: 'sub_frame',
  media: 'media',
  font: 'font',
  websocket: 'websocket',
  ping: 'ping',
  beacon: 'ping',
  other: 'other',
  webrtc: null,
  webtransport: null,
};

const METHODS = new Set(['connect', 'delete', 'get', 'head', 'options', 'patch', 'post', 'put']);

/**
 * スクリプレット（content/scriptlets.js にある処理）の名前と、フィルターで使われる別名。
 * ##+js(...) のうち、ここにないもの（trusted-* など）は使わない。
 */
export const SCRIPTLETS = {
  'set-constant': ['set'],
  'abort-on-property-read': ['aopr'],
  'abort-on-property-write': ['aopw'],
  'abort-current-script': ['acs', 'abort-current-inline-script', 'acis'],
  'abort-on-stack-trace': ['aost'],
  'addEventListener-defuser': ['aeld', 'prevent-addEventListener'],
  'prevent-setTimeout': ['no-setTimeout-if', 'nostif', 'setTimeout-defuser'],
  'prevent-setInterval': ['no-setInterval-if', 'nosiif', 'setInterval-defuser'],
  'adjust-setTimeout': ['nano-setTimeout-booster', 'nano-stb'],
  'adjust-setInterval': ['nano-setInterval-booster', 'nano-sib'],
  'no-window-open-if': ['nowoif', 'prevent-window-open', 'window.open-defuser'],
  nowebrtc: [],
  'remove-attr': ['ra'],
  'remove-class': ['rc'],
  'remove-node-text': ['rmnt'],
  'replace-node-text': ['rpnt'],
  'prevent-fetch': ['no-fetch-if'],
  'prevent-xhr': ['no-xhr-if'],
  noeval: ['silent-noeval'],
  'noeval-if': ['prevent-eval-if'],
  'json-prune': [],
  'json-prune-fetch-response': [],
  'xml-prune': [],
  nobab: ['bab-defuser'],
  nofab: ['fuckadblock.js-3.2.0'],
  'popads-dummy': ['popads.net'],
  'set-cookie': [],
  'set-cookie-reload': [],
  'set-local-storage-item': [],
  'set-session-storage-item': [],
  'prevent-refresh': ['refresh-defuser'],
  'spoof-css': [],
  'window.name-defuser': [],
  'href-sanitizer': [],
  'remove-cookie': ['cookie-remover'],
  'set-attr': [],
  'disable-newtab-links': [],
  'prevent-requestAnimationFrame': ['no-requestAnimationFrame-if', 'norafif'],
  'json-prune-xhr-response': [],
};

const SCRIPTLET_NAMES = new Map();
for (const [name, aliases] of Object.entries(SCRIPTLETS)) {
  for (const n of [name, ...aliases]) SCRIPTLET_NAMES.set(n, name);
}

// YouTube は content/yt-main.js が専用に対処する。リストのスクリプレットまで重ねると、YouTube 側の検出に引っかかりやすくなる。
const SCRIPTLET_SKIP_HOST_RE = /(^|\.)(youtube|youtube-nocookie)\.com$/;

// !#if の条件。Chromium の Manifest V3 で動く（uBlock Origin Lite と同じ制約の）拡張機能として判断する。ここにない名前は false。
const PREPROCESSOR_ENV = { env_chromium: true, env_mv3: true, ext_ubol: true, cap_user_stylesheet: true };

const HOST_RE = /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?)+$/;
// ドット区切りが 1 つだけのもの（com など TLD 1 つだけの指定や、example.* の example の部分）も含む
const LABELS_RE = /^[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]*[a-z0-9_])?)*$/;
const DOMAIN_ONLY_RE =/^\|\|([a-z0-9_.-]+)\^\|?$/;
const SIMPLE_CLASS_RE = /^\.(-?[A-Za-z_][\w-]*)$/;
const SIMPLE_ID_RE = /^#(-?[A-Za-z_][\w-]*)$/;
// ドメイン部分 + 区切り（## #@# #?# #$# #%# $$ など）+ 本体
const COSMETIC_RE = /^([^#$\s]*)(#@?[$?%]?#|\$@?\$)(.*)$/;
// 選択子:style(宣言)
const STYLE_RE = /^(.+?):style\((.+)\)$/;
// 拡張 CSS（uBlock Origin・AdGuard・ABP 独自の擬似クラス）。ブラウザーの CSS としては使えない。
const PROCEDURAL_RE =
  /:(?:-abp-|-ext-|has-text|contains|xpath|upward|style|remove|matches-|min-text-length|watch-attr|others|if\(|if-not|nth-ancestor|properties)/;

/**
 * フィルター 1 行を読む。扱えない行は null。
 *  - { kind: 'network', allow, important, host, urlFilter, condition, redirect, removeParam, regexFilter, regexSubstitution }
 *  - { kind: 'cosmetic', exception, include, exclude, selector, style }
 *  - { kind: 'cosmetic-switch', host, mode: 'generic' | 'all' }   … @@||site^$generichide / $elemhide
 *  - { kind: 'scriptlet', exception, include, exclude, name, args }  … example.com##+js(name, args…)
 */
export function parseFilter(line) {
  const m = COSMETIC_RE.exec(line);
  return m ? parseCosmetic(m) : parseNetwork(line);
}

function parseCosmetic([, domainText, separator, body]) {
  // #?#・#@?# は uBlock Origin・AdGuard の拡張 CSS（手続き型）。中身が純粋な CSS なら ## と同じに扱う
  if (separator !== '##' && separator !== '#@#' && separator !== '#?#' && separator !== '#@?#') return null;
  const exception = separator === '#@#' || separator === '#@?#';
  // example.*（エンティティ）はそのまま持ち、実行時にページのホスト名と照らし合わせる（lib/hosts.js の entityChain）
  const domains = splitDomains(domainText, ',', { entities: 'keep' });
  if (!domains) return null;
  const { include, exclude } = domains;
  if (body.startsWith('+js(')) return separator === '##' || separator === '#@#' ? parseScriptlet(body, exception, include, exclude) : null;

  // :-abp-has(...) は :has(...) と同じ意味（中が純粋な CSS ならブラウザーがそのまま解釈できる）
  let selector = body.trim().replace(/:-abp-has\(/gi, ':has(');
  let style = null;
  if (selector.endsWith(':remove()')) {
    // 要素を取り除く代わりに隠す
    selector = selector.slice(0, -':remove()'.length);
  } else {
    const m = STYLE_RE.exec(selector);
    if (m) {
      selector = m[1];
      style = m[2].trim();
      // 全サイト共通の :style() は使わない（uBlock Origin と同じ）
      if (!isUsableStyle(style) || (!include.length && !exception)) return null;
    }
  }
  if (!isUsableSelector(selector)) {
    // 拡張 CSS（:has-text() など）。全サイト共通のものは、ページ全体を調べることになって重いので使わない（例外は受け付ける）
    const full = body.trim().replace(/:-abp-has\(/gi, ':has(');
    if (!PROCEDURAL_RE.test(full) || (!include.length && !exception) || !parseProcedural(full)) return null;
    return { kind: 'cosmetic', exception, include, exclude, selector: full, style: null, procedural: true };
  }
  return { kind: 'cosmetic', exception, include, exclude, selector, style };
}

/** そのまま CSS の選択子として入れてよいか（ほかのルールを壊さないか）。 */
export function isUsableSelector(s) {
  return (
    s.length > 0 &&
    s.length <= 1000 &&
    !/^[+^@]/.test(s) && // ##+js(...) ##^... などは選択子ではない
    !/[{}\x00-\x1f]|\/\*|\\$/.test(s) &&
    !PROCEDURAL_RE.test(s) &&
    isBalanced(s)
  );
}

/** :style() の中身として入れてよい宣言か。外部の URL を読ませるものや、ルールの外に出るものは使わない。 */
export function isUsableStyle(s) {
  return (
    s.length > 0 &&
    s.length <= 1000 &&
    /^-{0,2}[a-z][\w-]*\s*:/i.test(s) && // --custom-property も使える
    !/[{}<>\\\x00-\x1f]|\/\*|url\(|image-set\(|expression\(|@import/i.test(s) &&
    isBalanced(s)
  );
}

// 引用符や括弧が閉じていないと、後ろに続く CSS ルールまで巻き込んで無効にしてしまう
function isBalanced(s) {
  const stack = [];
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '(' || ch === '[') {
      stack.push(ch === '(' ? ')' : ']');
    } else if ((ch === ')' || ch === ']') && stack.pop() !== ch) {
      return false;
    }
  }
  return !quote && stack.length === 0;
}

// ---- 手続き型の要素隠し（uBlock Origin・AdGuard・ABP の拡張 CSS）----
// ブラウザーの CSS では書けない選択子（:has-text()・:upward() など）を、変換のときに「基点の CSS + 演算子の列」の
// プログラム（JSON）に分ける。ページでの評価は content/procedural.js が行う（DOM に触る部分はあちらだけ）。
//
// プログラム = { c: 基点の CSS, s: [演算子…], a?: 最後の操作, p?: ページの URL 条件, w?: 属性の変化も見る }
//   s の演算子（配列の先頭が名前）:
//     ['text', パターン]            … :has-text() / :contains() / :-abp-contains()（テキストに含む）
//     ['has', プログラム] / ['nothas', プログラム] / ['not', プログラム]  … :has() / :if() / :if-not() / :not()（中が手続き型のもの）
//     ['up', 数 | CSS]              … :upward() / :nth-ancestor()
//     ['xpath', 式]
//     ['mcss', プロパティ, パターン, '' | '::before' | '::after']  … :matches-css()
//     ['mattr', 名前のパターン, 値のパターン | null]  … :matches-attr()
//     ['mmedia', クエリー] / ['minlen', 数] / ['others']
//     ['sel', CSS] / ['sib', CSS] / ['f', CSS]  … 演算子のあとに続く CSS（子孫・子 / 兄弟 / その要素自身の絞り込み）
//   パターン = ['t', 文字列]（含む）/ ['e', 文字列]（* を使える完全一致）/ ['r', 正規表現, フラグ]
//   a = ['rm'] | ['style', 宣言] | ['ra', 名前] | ['rc', 名前]（ない場合は display:none!important で隠す）
//   p = [パターン…]（:matches-path()。すべて満たすページでだけ動く）
// 解析できないもの・危ないものは null（そのフィルターは使わない）。

const PROC_KIND = new Map([
  ['has-text', 'text'], ['contains', 'text'],
  ['has', 'has'], ['if', 'has'], ['if-not', 'nothas'], ['not', 'not'],
  ['upward', 'up'], ['nth-ancestor', 'up'], ['xpath', 'xpath'],
  ['matches-css', 'mcss'], ['matches-css-before', 'mcss'], ['matches-css-after', 'mcss'],
  ['matches-attr', 'mattr'], ['matches-media', 'mmedia'], ['matches-path', 'path'],
  ['min-text-length', 'minlen'], ['others', 'others'], ['watch-attr', 'watch'],
  ['remove', 'rm'], ['remove-attr', 'ra'], ['remove-class', 'rc'], ['style', 'style'],
]);
// 再現できない擬似クラス（プロパティの照合など）。これがあるフィルターは使わない
const PROC_UNSUPPORTED = new Set(['properties', 'matches-prop', 'matches-property', 'subject']);
const PROC_ANY_RE =
  /:(?:-abp-|-ext-)?(?:has-text|contains|if|if-not|upward|nth-ancestor|xpath|matches-[\w-]+|min-text-length|others|watch-attr|remove(?:-attr|-class)?|style|properties|subject)\(/i;
const PROC_MAX_DEPTH = 4;
const isWordChar = (ch) => ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);
// 引用符の始まり。Don't の ' のような、単語の途中の引用符は数えない
const opensQuote = (text, i) => (text[i] === '"' || text[i] === "'") && !isWordChar(text[i - 1]);

function skipQuote(text, i) {
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === '\\') j++;
    else if (text[j] === text[i]) return j;
  }
  return -1;
}

// [ ] は入れ子になることがある（XPath の条件の中の条件など）
function skipBracket(text, i) {
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    const ch = text[j];
    if (ch === '\\') j++;
    else if (ch === '"' || ch === "'") {
      j = skipQuote(text, j);
      if (j < 0) return -1;
    } else if (ch === '[') depth++;
    else if (ch === ']' && --depth === 0) return j;
  }
  return -1;
}

// text[open] の ( に対応する ) の位置。なければ -1
function findClose(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') i++;
    else if (opensQuote(text, i)) {
      i = skipQuote(text, i);
      if (i < 0) return -1;
    } else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i;
  }
  return -1;
}

// 括弧・引用符・[] の外にある sep で分ける。閉じていなければ null
export function splitTop(text, sep) {
  const out = [];
  let from = 0;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      i++;
    } else if (opensQuote(text, i)) {
      i = skipQuote(text, i);
      if (i < 0) return null;
    } else if (ch === '[') {
      i = skipBracket(text, i);
      if (i < 0) return null;
    } else if (ch === '(') {
      depth++;
    } else if (ch === ')') {
      if (--depth < 0) return null;
    } else if (ch === sep && depth === 0) {
      out.push(text.slice(from, i));
      from = i + 1;
    }
  }
  if (depth !== 0) return null;
  out.push(text.slice(from));
  return out;
}

// 選択子を、手続き型の擬似クラスの前後で CSS の断片に分ける。chunks.length === ops.length + 1
function splitPseudos(text) {
  const chunks = [];
  const ops = [];
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      i++;
    } else if (opensQuote(text, i)) {
      i = skipQuote(text, i);
      if (i < 0) return null;
    } else if (ch === '[') {
      i = skipBracket(text, i);
      if (i < 0) return null;
    } else if (ch === ':') {
      if (text[i + 1] === ':') {
        i++;
        continue;
      }
      const m = /^:(-?[a-z][\w-]*)\(/i.exec(text.slice(i, i + 40));
      if (!m) continue;
      const open = i + m[0].length - 1;
      const close = findClose(text, open);
      if (close < 0) return null;
      const name = m[1].toLowerCase().replace(/^-(?:abp|ext)-/, '');
      const arg = text.slice(open + 1, close);
      if (PROC_UNSUPPORTED.has(name)) return null;
      const kind = PROC_KIND.get(name);
      const inner = PROC_ANY_RE.test(arg);
      // :has() と :not() は、中に手続き型があるときだけ演算子にする（純粋な CSS ならブラウザーが解釈する）
      if (kind && (inner || (name !== 'has' && name !== 'not'))) {
        chunks.push(text.slice(from, i));
        ops.push({ name, kind, arg });
        from = close + 1;
      } else if (inner) {
        return null; // :is(:has-text(...)) のように、中の手続き型を取り出せないもの
      }
      i = close;
    }
  }
  chunks.push(text.slice(from));
  return { chunks, ops };
}

// 正規表現の長さ・入れ子の繰り返し・後方参照を避ける（ReDoS 対策）。使えるなら true
function isSafeRegex(source, flags) {
  if (source.length > 2000 ||!/^[imsu]*$/.test(flags)) return false;
  if (/\\[1-9]|\\k</.test(source)) return false;
  if (/\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/.test(source)) return false;
  try {
    new RegExp(source, flags);
    return true;
  } catch {
    return false;
  }
}

// 'text' なら含むか、'glob' なら * を使える完全一致。/正規表現/フラグ もよい。
// AdGuard は正規表現の中のバックスラッシュを 2 つ重ねて書くので、collapse のときは 1 つにする
function parsePattern(raw, kind, collapse = false) {
  let s = raw.trim();
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s.at(-1) === s[0]) s = s.slice(1, -1);
  const m = /^\/(.+)\/([dgimsuvy]*)$/s.exec(s);
  if (m) {
    const source = collapse ? m[1].replace(/\\\\/g, '\\') : m[1];
    const flags = m[2].replace(/[gy]/g, '');
    return isSafeRegex(source, flags) ? ['r', source, flags] : null;
  }
  return s ? [kind === 'text' ? 't' : 'e', s] : null;
}

// :matches-attr("name"="value") / :matches-attr(name=value) / :matches-attr("name")
function parseAttrArg(arg) {
  const s = arg.trim();
  let name;
  let rest;
  if (s[0] === '"' || s[0] === "'") {
    const j = skipQuote(s, 0);
    if (j < 0) return null;
    name = s.slice(1, j);
    rest = s.slice(j + 1).trim();
    if (rest && rest[0] !== '=') return null;
  } else {
    const eq = s.indexOf('=');
    name = eq < 0 ? s : s.slice(0, eq);
    rest = eq < 0 ? '' : s.slice(eq);
  }
  const namePattern = parsePattern(name, 'glob', true);
  if (!namePattern) return null;
  if (!rest) return ['mattr', namePattern, null];
  const valuePattern = parsePattern(rest.slice(1), 'glob', true);
  return valuePattern ? ['mattr', namePattern, valuePattern] : null;
}

// CSS の断片として入れてよいか（ルールを壊さない・長すぎない）
function isCssPiece(s) {
  return s.length <= 4000 && !/[{}\x00-\x1f]|\/\*|\\$/.test(s) && isBalanced(s);
}

// 演算子 1 つ → { step } | { action } | { path } | { watch } | null（使えない）
function parseOp({ name, kind, arg }, depth) {
  const a = arg.trim();
  switch (kind) {
    case 'text': {
      const p = parsePattern(arg, 'text');
      return p && { step: ['text', p] };
    }
    case 'has':
    case 'nothas':
    case 'not': {
      const inner = parseCompound(a, { inner: true, depth: depth + 1 });
      if (!inner || (kind === 'not' && /^[>+~]/.test(inner.c))) return null;
      return { step: [kind, inner] };
    }
    case 'up': {
      if (/^\d+$/.test(a)) return +a >= 1 && +a <= 32 ? { step: ['up', +a] } : null;
      return a && !PROC_ANY_RE.test(a) && isCssPiece(a) ? { step: ['up', a] } : null;
    }
    case 'xpath':
      return a && a.length <= 3000 && isBalanced(a) ? { step: ['xpath', a] } : null;
    case 'mcss': {
      // 古い AdGuard の書き方: :matches-css(before, content: /re/)
      const old = /^(before|after)\s*,\s*/i.exec(a);
      const decl = old ? a.slice(old[0].length) : a;
      const colon = decl.indexOf(':');
      const prop = decl.slice(0, colon).trim().toLowerCase();
      const value = colon < 0 ? null : parsePattern(decl.slice(colon + 1), 'glob', true);
      if (!value || !/^-?[a-z][\w-]*$/.test(prop)) return null;
      const pseudo = old ? `::${old[1].toLowerCase()}` : name.endsWith('-before') ? '::before' : name.endsWith('-after') ? '::after' : '';
      return { step: ['mcss', prop, value, pseudo] };
    }
    case 'mattr': {
      const step = parseAttrArg(arg);
      return step && { step };
    }
    case 'mmedia':
      return a && a.length <= 300 && isBalanced(a) ? { step: ['mmedia', a] } : null;
    case 'minlen':
      return /^\d{1,6}$/.test(a) ? { step: ['minlen', +a] } : null;
    case 'others':
      return a === '' ? { step: ['others'] } : null;
    case 'watch':
      return { watch: true };
    case 'path': {
      const p = parsePattern(arg, 'text', true);
      return p && { path: p };
    }
    case 'rm':
      return a === '' ? { action: ['rm'] } : null;
    case 'style':
      return isUsableStyle(a) ? { action: ['style', a] } : null;
    case 'ra':
      return /^[\w:.-]{1,100}$/.test(a) ? { action: ['ra', a] } : null;
    case 'rc':
      return /^-?[_a-zA-Z][\w-]{0,99}$/.test(a) ? { action: ['rc', a] } : null;
  }
  return null;
}

// 選択子 1 つ（カンマで分けたあとのもの）を、プログラムにする。使えなければ null
function parseCompound(text, { inner, depth }) {
  if (depth > PROC_MAX_DEPTH || text.length > 5000) return null;
  const sp = splitPseudos(text);
  if (!sp) return null;
  const steps = [];
  const paths = [];
  const follow = []; // follow[k] = steps[k] のあとに続く CSS
  let base = null;
  let cur = sp.chunks[0];
  let action = null;
  let watch = false;
  for (let j = 0; j < sp.ops.length; j++) {
    const r = parseOp(sp.ops[j], depth);
    const rest = sp.chunks[j + 1];
    if (!r) return null;
    if (r.path) {
      if (inner) return null;
      paths.push(r.path);
      cur += rest;
    } else if (r.watch) {
      watch = true;
      cur += rest;
    } else if (r.action) {
      // 取り除く・見た目を変える操作は、いちばん最後の 1 つだけ
      if (inner || j !== sp.ops.length - 1 || rest.trim()) return null;
      action = r.action;
    } else {
      if (base === null) base = cur;
      else follow.push(cur);
      steps.push(r.step);
      cur = rest;
    }
  }
  if (base === null) base = cur;
  else follow.push(cur);

  base = base.trim();
  // :xpath(//...) だけの選択子は、ページ全体（html）を起点に式を評価する
  if (!base && !inner && steps[0]?.[0] === 'xpath') base = ':root';
  if (!isCssPiece(base) || /^[+~]/.test(base) || (!inner && (!base || /^>/.test(base)))) return null;
  const s = [];
  for (let k = 0; k < steps.length; k++) {
    s.push(steps[k]);
    const raw = follow[k];
    const t = raw.trim();
    if (!t) continue;
    if (!isCssPiece(t)) return null;
    // 空白か結合子で始まるなら「その要素から探す」、そうでなければ「その要素自身を絞る」
    if (/^[+~]/.test(t)) s.push(['sib', t]);
    else if (/^\s/.test(raw) || t[0] === '>') s.push(['sel', t]);
    else s.push(['f', t]);
  }
  const program = { c: base, s };
  if (action) program.a = action;
  if (paths.length) program.p = paths;
  if (watch) program.w = true;
  return program;
}

/**
 * 手続き型の選択子（カンマ区切りの列でもよい）を読む。{ programs: プログラムの配列 } または null。
 * 手続き型の要素を 1 つも含まない（純粋な CSS の）ものも null。
 */
export function parseProcedural(text) {
  try {
    const body = text.trim().replace(/:-abp-has\(/gi, ':has(');
    if (!body || body.length > 6000) return null;
    // :others() は、その前のカンマ区切りの全体が「残す要素」になる
    const items = /:others\(/i.test(body) ? [body] : splitTop(body, ',');
    if (!items) return null;
    const programs = [];
    for (const item of items) {
      const program = parseCompound(item.trim(), { inner: false, depth: 0 });
      if (!program) return null;
      if (program.s.some((st) => st[0] === 'others') && (program.s.length !== 1 || items.length !== 1)) return null;
      programs.push(program);
    }
    // 最後の項目だけに :style() / :remove() があるときは、リスト全体に掛ける（通常の CSS のときと同じ）
    const last = programs.at(-1);
    if (last.a) for (const p of programs) p.a ??= last.a;
    return programs.some((p) => p.s.length || p.a || p.p) ? { programs } : null;
  } catch {
    return null;
  }
}

// a.com,~b.a.com のようなドメイン指定を読む。
// 正規表現の指定は扱えない。対象から外すだけなら適用範囲が狭まるだけなので、その指定だけ捨てる（dropped に数える）。
// 除外側（~example.*）は捨てると範囲が広がってしまうので、フィルターごと使わない。
// example.*（エンティティ）は、entities が true のときだけ ENTITY_TLDS の一覧に展開する（通信ルール用。展開した数が上限を超えたらフィルターごと使わない）。
// entities が 'keep' のとき（要素隠し・スクリプレット）は展開せず、除外側も含めて example.* のまま持つ。
// tld のときは com のような TLD だけの指定も使う（DNR の requestDomains・initiatorDomains は "com" でそのサフィックスの全ホストに当たる）。
function splitDomains(text, separator, { entities = false, tld = false } = {}) {
  const include = [];
  const exclude = [];
  let dropped = 0;
  if (!text) return { include, exclude, dropped };
  for (let d of text.split(separator)) {
    d = d.trim().toLowerCase();
    if (!d) continue;
    const negated = d.startsWith('~');
    if (negated) d = d.slice(1);
    // 要素隠し・スクリプレット: example.* はそのまま持つ。除外側（~example.*）も持つ（捨てると範囲が広がるため）
    if (entities === 'keep' && d.endsWith('.*') && LABELS_RE.test(d.slice(0, -2))) {
      (negated ? exclude : include).push(d);
      continue;
    }
    if (!negated && entities === true && d.endsWith('.*') && LABELS_RE.test(d.slice(0, -2))) {
      const base = d.slice(0, -2);
      for (const t of ENTITY_TLDS) include.push(`${base}.${t}`);
      if (include.length > MAX_ENTITY_DOMAINS) return null;
      continue;
    }
    if (!(tld ? LABELS_RE : HOST_RE).test(d)) {
      if (negated) return null;
      dropped++;
      continue;
    }
    (negated ? exclude : include).push(d);
  }
  if (dropped && !include.length) return null;
  return { include, exclude, dropped };
}

// +js(name, 'arg, with comma', arg\, two) の引数を分ける
function splitArgs(text) {
  const args = [];
  let i = 0;
  for (;;) {
    while (text[i] === ' ') i++;
    const quote = text[i];
    let value = '';
    let j;
    if (quote === '"' || quote === "'" || quote === '`') {
      for (j = i + 1; j < text.length && text[j] !== quote; j++) {
        if (text[j] === '\\' && text[j + 1] === quote) j++;
        value += text[j];
      }
      if (j >= text.length) return null; // 引用符が閉じていない
      j++;
      while (text[j] === ' ') j++;
      if (j < text.length && text[j] !== ',') return null;
    } else {
      for (j = i; j < text.length && text[j] !== ','; j++) {
        if (text[j] === '\\' && text[j + 1] === ',') j++;
        value += text[j];
      }
      value = value.trim();
    }
    args.push(value);
    if (j >= text.length) return args;
    i = j + 1;
  }
}

function parseScriptlet(body, exception, include, exclude) {
  if (!body.endsWith(')')) return null;
  const args = splitArgs(body.slice(4, -1));
  if (!args) return null;
  if (args.length === 1 && args[0] === '') {
    // example.com#@#+js() … そのサイトではスクリプレットをすべて止める
    return exception && include.length ? { kind: 'scriptlet', exception, include, exclude, name: '', args: [] } : null;
  }
  const name = SCRIPTLET_NAMES.get(args[0].replace(/\.js$/, ''));
  if (!name) return null;
  // 全サイト共通のものは使わない（uBlock Origin と同じ）
  const hosts = include.filter((h) => !SCRIPTLET_SKIP_HOST_RE.test(h));
  if (!hosts.length) return null;
  return { kind: 'scriptlet', exception, include: hosts, exclude, name, args: args.slice(1) };
}

// オプションの名前（parseNetwork の switch と TYPE_MAP）。正規表現のフィルターでオプションの始まりを探すのに使う
const OPTION_NAMES = new Set([
  ...Object.keys(TYPE_MAP),
  'third-party', '3p', 'first-party', '1p', 'match-case', 'important', 'all', 'domain', 'from', 'to', 'denyallow',
  'method', 'redirect', 'redirect-rule', 'removeparam', 'uritransform', 'elemhide', 'ehide', 'generichide', 'ghide',
  'popup', 'document', 'doc', 'csp', 'badfilter', 'inline-script', 'inline-font', 'cname', 'permissions', 'replace',
  'header', 'empty', 'mp4', 'queryprune', 'urlskip',
]);

// 正規表現のフィルター（/.../$options）で、オプションの始まりの $ の位置。
// 置き換えの中にも $ があるので（uritransform=//$1$2/）、「/$」の直後が既知のオプション名のものを左から探す。
function findRegexOptionStart(line) {
  for (let i = line.indexOf('$', 2); i >= 0; i = line.indexOf('$', i + 1)) {
    if (line[i - 1] !== '/' || i === line.length - 1) continue;
    const name = /^~?([^,=]*)/.exec(line.slice(i + 1))[1].trim().toLowerCase();
    if (OPTION_NAMES.has(name)) return i;
  }
  return -1;
}

// regexFilter の長さの上限
const MAX_REGEX_LENGTH = 1000;
// regexCost の上限。実機（Chrome 157）の較正データで、見積もりが 112 以下の式は受理され、115 以上の式は 1 件を除いてすべて拒否された。
// 受理された最大（112）と拒否された最小（115）の間の、安全側（受理された最大）に置く。
export const REGEX_COST_LIMIT = 112;

/**
 * 正規表現を RE2 がコンパイルしたときのプログラムの大きさ（命令の数）の見積もり。
 * Chrome は、コンパイル後が 2KB を超える regexFilter を memoryLimitExceeded で受け付けない。
 * 実機（Chrome 157）で受理された 148 件・拒否された 30 件に合わせて、数え方と上限（REGEX_COST_LIMIT）を決めてある。
 *  - 文字 1 つ・\d は 1、範囲 k 個の文字クラスは 2k-1（大文字小文字を区別しないときは A-Z を a-z に寄せて数える）、. や否定クラスは 10 前後
 *  - x{n,m} は x を n 個並べ、残りの (m-n) 個は 1 つずつ省略可能にして入れ子にする。x{n,} は n 個 + 繰り返し
 *  - ^ で始まる式の先頭のリテラルは、RE2 が接頭辞として取り出すのでプログラムに入らない
 * @param {string} re
 * @param {boolean} [caseSensitive]
 */
export function regexCost(re, caseSensitive = false) {
  const ANY = 10; // . や否定クラス（UTF-8 の全範囲）
  let i = 0;
  const alt = () => {
    let total = 0;
    let n = 0;
    do {
      if (n++) i++;
      total += seq();
    } while (re[i] === '|');
    return total + n - 1;
  };
  const seq = () => {
    let total = 0;
    while (i < re.length && re[i] !== '|' && re[i] !== ')') total += quant(atom());
    return total;
  };
  const atom = () => {
    const ch = re[i++];
    if (ch === '(') {
      let capture = 2;
      if (re[i] === '?') {
        if (re[i + 1] === ':') {
          i += 2;
          capture = 0;
        } else if (re[i + 1] === 'P' || re[i + 1] === '<') {
          i = re.indexOf('>', i) + 1;
        } else {
          i = re.indexOf(')', i) + 1; // (?i) などのフラグ
          return 0;
        }
      }
      const size = alt();
      i++;
      return size + capture;
    }
    if (ch === '[') return charClass();
    if (ch === '.') return ANY;
    if (ch === '\\') {
      const c = re[i++];
      if (c === 'd') return 1;
      if (c === 'w') return 7; // 0-9 A-Z _ a-z の 4 範囲
      if (c === 's') return 3;
      if (c === 'D' || c === 'W' || c === 'S') return ANY;
    }
    return 1;
  };
  const charClass = () => {
    let negated = false;
    if (re[i] === '^') {
      negated = true;
      i++;
    }
    const set = [];
    let first = true;
    let word = false;
    let notWord = false;
    while (i < re.length && (re[i] !== ']' || first)) {
      first = false;
      let c = re[i++];
      if (c === '\\') {
        const e = re[i++];
        if (e === 'w') {
          set.push([48, 57], [65, 90], [95, 95], [97, 122]);
          word = true;
          continue;
        }
        if (e === 'd') {
          set.push([48, 57]);
          continue;
        }
        if (e === 's') {
          set.push([9, 13], [32, 32]);
          continue;
        }
        if (e === 'W' || e === 'D' || e === 'S') {
          notWord = true;
          continue;
        }
        c = e;
      }
      const lo = c.charCodeAt(0);
      let hi = lo;
      if (re[i] === '-' && re[i + 1] !== ']' && i + 1 < re.length) {
        i++;
        let h = re[i++];
        if (h === '\\') h = re[i++];
        hi = h.charCodeAt(0);
      }
      set.push([lo, hi]);
    }
    i++;
    if (word && notWord) return ANY;
    if (!caseSensitive) {
      // 大文字は小文字に寄せる（RE2 は a-z を大文字小文字無視の 1 つの範囲にできる）
      for (const [lo, hi] of [...set]) {
        const l = Math.max(lo, 65);
        const h = Math.min(hi, 90);
        if (l <= h) set.push([l + 32, h + 32]);
      }
      for (let k = set.length - 1; k >= 0; k--) {
        // 大文字の部分は小文字側に写してあるので、元の範囲から大文字を除く
        const [lo, hi] = set[k];
        if (hi < 65 || lo > 90) continue;
        const parts = [];
        if (lo < 65) parts.push([lo, 64]);
        if (hi > 90) parts.push([91, hi]);
        set.splice(k, 1, ...parts);
      }
    }
    set.sort((a, b) => a[0] - b[0]);
    let ranges = 0;
    let end = -2;
    for (const [lo, hi] of set) {
      if (lo > end + 1) {
        ranges++;
        end = hi;
      } else if (hi > end) {
        end = hi;
      }
    }
    return ranges * 2 - 1 + (negated || notWord ? ANY : 0);
  };
  const quant = (size) => {
    let s = size;
    for (;;) {
      const c = re[i];
      if (c === '*' || c === '+' || c === '?') {
        i++;
        if (re[i] === '?') i++;
        s += 1;
      } else if (c === '{') {
        const m = /^\{(\d+)(?:(,)(\d*))?\}/.exec(re.slice(i, i + 16));
        if (!m) return s;
        i += m[0].length;
        const n = Number(m[1]);
        if (!m[2]) s *= n;
        else if (m[3] === '') s = s * Math.max(n, 1) + 1;
        else s = s * n + (Number(m[3]) - n) * (s + 1);
        if (re[i] === '?') i++;
      } else {
        return s;
      }
    }
  };
  let prefix = 0;
  if (re[0] === '^') {
    for (let j = 1; j < re.length; ) {
      let len = 1;
      if (re[j] === '\\') {
        if (!/[^a-zA-Z0-9]/.test(re[j + 1] ?? 'a')) break;
        len = 2;
      } else if (/[.[\](){}*+?|^$]/.test(re[j])) {
        break;
      }
      if (/[*+?{]/.test(re[j + len] ?? '')) break;
      prefix++;
      j += len;
    }
  }
  return alt() - prefix;
}

// RE2（DNR の regexFilter）で使える正規表現か。使えないものは null、使えるなら捕捉グループの数を返す
function regexGroupCount(re, caseSensitive = false) {
  if (!re || re.length > MAX_REGEX_LENGTH || /[^\x20-\x7e]/.test(re) || /\(\?(?:=|!|<=|<!|>)/.test(re)) return null;
  // RE2 にない書き方（\uXXXX・\k<名前>・\cX）と、コンパイル後が 2KB に収まらない大きな式（.{100,}・[0-9a-f]{32} など）
  if (/\\[ukc]/.test(re) || regexCost(re, caseSensitive) > REGEX_COST_LIMIT) return null;
  let groups = 0;
  let inClass = false;
  for (let i = 0; i < re.length; i++) {
    const ch = re[i];
    if (ch === '\\') {
      if (/[1-9]/.test(re[i + 1] ?? '')) return null; // 後方参照
      i++;
    } else if (inClass) {
      if (ch === ']') inClass = false;
    } else if (ch === '[') {
      inClass = true;
      if (re[i + 1] === '^') i++;
      if (re[i + 1] === ']') i++;
    } else if (ch === '(') {
      if (re[i + 1] !== '?' || /^\(\?P?<[A-Za-z_]/.test(re.slice(i))) groups++;
    }
  }
  return inClass ? null : groups;
}

// uritransform=//置き換え/ の置き換えを DNR の regexSubstitution（\1〜\9）にする。変換できないものは null
function toRegexSubstitution(value, groups) {
  const m = /^\/\/(.*)\/$/s.exec(value);
  if (!m || m[1].includes('\\')) return null;
  let ok = true;
  const out = m[1].replace(/\$([1-9])/g, (_, n) => {
    if (Number(n) > groups) ok = false;
    return '\\' + n;
  });
  return ok && !out.includes('$') && out ? out : null;
}

const PARAM_NAME_RE = /^[A-Za-z0-9_.\-[\]]+$/;
// $removeparam・uritransform の既定の種類（uBlock Origin Lite と同じ）
const PARAM_DEFAULT_TYPES = ['main_frame', 'sub_frame', 'xmlhttprequest'];

function parseNetwork(text) {
  let line = text;
  const allow = line.startsWith('@@');
  if (allow) line = line.slice(2);

  let pattern = line;
  let optionText = '';
  const isRegex = (s) => s.length > 1 && s.startsWith('/') && s.endsWith('/');
  const regexDollar = line.startsWith('/') ? findRegexOptionStart(line) : -1;
  if (regexDollar >= 0) {
    pattern = line.slice(0, regexDollar);
    optionText = line.slice(regexDollar + 1);
  } else {
    const dollar = line.lastIndexOf('$');
    if (dollar >= 0 && dollar < line.length - 1 && !(line.length > 1 && line.startsWith('/') && line.endsWith('/'))) {
      pattern = line.slice(0, dollar);
      optionText = line.slice(dollar + 1);
    }
  }
  // 正規表現のフィルターは、RE2 で使える書き方のものだけ扱う（regexGroupCount）。
  // /.../ の形でも、途中に |$script,... のようなオプションがあるもの（$replace=/x/y/ や $header=...:/x/ の行）は正規表現ではない
  const regex = isRegex(pattern);
  if (regex && /[^\\]\$~?[a-z0-9-]+[=,]/.test(pattern)) return null;

  const condition = {};
  const types = new Set();
  const notTypes = new Set();
  let important = false;
  let unsupportedType = false;
  let cosmeticSwitch = null;
  let redirect = null;
  let removeParam = null;
  let uritransform = null;
  let csp = null;
  let documentOpt = false;

  for (const raw of optionText ? optionText.split(',') : []) {
    const negated = raw.startsWith('~');
    const option = negated ? raw.slice(1) : raw;
    const eq = option.indexOf('=');
    const name = (eq < 0 ? option : option.slice(0, eq)).trim().toLowerCase();
    const value = eq < 0 ? '' : option.slice(eq + 1);

    if (Object.hasOwn(TYPE_MAP, name)) {
      const type = TYPE_MAP[name];
      if (negated) {
        if (type) notTypes.add(type);
      } else if (type) {
        types.add(type);
      } else {
        unsupportedType = true;
      }
      continue;
    }

    switch (name) {
      case 'third-party':
      case '3p':
        condition.domainType = negated ? 'firstParty' : 'thirdParty';
        break;
      case 'first-party':
      case '1p':
        condition.domainType = negated ? 'thirdParty' : 'firstParty';
        break;
      case 'match-case':
        if (negated) return null;
        condition.isUrlFilterCaseSensitive = true;
        break;
      case 'document':
      case 'doc':
        // ページそのもの（main_frame）。例外（@@）のときは下で allowAllRequests にする
        if (negated) notTypes.add('main_frame');
        else documentOpt = true;
        break;
      case 'csp':
        // 応答ヘッダーに Content-Security-Policy を足す。値なしの例外（@@...$csp）は、DNR では対応する csp ルールだけを打ち消せないので使わない
        if (allow || negated || !/^[ -~]{1,1000}$/.test(value)) return null;
        csp = value.trim();
        break;
      case 'important':
        if (negated) return null;
        important = true;
        break;
      case 'all':
        if (negated) return null;
        break;
      case 'domain':
      case 'from': {
        const d = splitDomains(value, '|', { entities: true, tld: true });
        if (!d || negated) return null;
        if (d.include.length) condition.initiatorDomains = d.include;
        if (d.exclude.length) condition.excludedInitiatorDomains = d.exclude;
        break;
      }
      case 'to': {
        const d = splitDomains(value, '|', { entities: true, tld: true });
        if (!d || negated) return null;
        if (d.include.length) condition.requestDomains = d.include;
        if (d.exclude.length) condition.excludedRequestDomains = [...(condition.excludedRequestDomains ?? []), ...d.exclude];
        break;
      }
      case 'denyallow': {
        // 捨てたドメインがあると、止めてはいけない先まで止めてしまう
        const d = splitDomains(value, '|', { tld: true });
        if (!d || negated || d.exclude.length || d.dropped) return null;
        condition.excludedRequestDomains = [...(condition.excludedRequestDomains ?? []), ...d.include];
        break;
      }
      case 'method': {
        const include = [];
        const exclude = [];
        for (const m of value.toLowerCase().split('|')) {
          const not = m.startsWith('~');
          const method = not ? m.slice(1) : m;
          if (!METHODS.has(method) || negated) return null;
          (not ? exclude : include).push(method);
        }
        if (include.length) condition.requestMethods = include;
        if (exclude.length) condition.excludedRequestMethods = exclude;
        break;
      }
      case 'redirect': {
        // 止める代わりに、何もしない偽物（resources/）を読み込ませる。名前の後ろの :5 などは uBlock Origin の優先度なので無視する
        if (allow || negated) return null;
        redirect = redirectPath(value.replace(/:\d+$/, ''));
        if (!redirect) return null;
        break;
      }
      case 'removeparam':
        // 名前 1 つだけ。値なし（全部消す）や /正規表現/ は使わない。DNR にはパラメーター削除だけの例外がないので @@ も使わない
        if (allow || negated || !PARAM_NAME_RE.test(value)) return null;
        removeParam = value;
        break;
      case 'uritransform':
        if (allow || negated) return null;
        uritransform = value;
        break;
      case 'elemhide':
      case 'ehide':
        if (!allow || negated) return null;
        cosmeticSwitch = 'all';
        break;
      case 'generichide':
      case 'ghide':
        if (!allow || negated) return null;
        cosmeticSwitch ??= 'generic';
        break;
      default:
        // popup・redirect-rule・badfilter など、ここでは再現できないもの
        return null;
    }
  }

  if (removeParam && (redirect || uritransform)) return null;
  if (csp !== null && (redirect || removeParam || uritransform || cosmeticSwitch)) return null;
  if (uritransform !== null && !regex) return null; // 正規表現でない uritransform は使わない
  let regexFilter = null;
  let regexSubstitution = null;
  if (regex) {
    regexFilter = pattern.slice(1, -1);
    const groups = regexGroupCount(regexFilter, condition.isUrlFilterCaseSensitive === true);
    if (groups === null || regexFilter.length < 6 || cosmeticSwitch) return null;
    if (uritransform !== null) {
      regexSubstitution = toRegexSubstitution(uritransform, groups);
      if (!regexSubstitution || redirect) return null;
    }
  }

  let allowAll = false;
  if (documentOpt) {
    if (cosmeticSwitch || csp !== null) return null;
    if (allow) {
      // @@...$document … そのページでは何も止めない（allowAllRequests）。initiator はページの 1 つ前のものになるので、domain= とは組み合わせない
      if (redirect || removeParam || regex || unsupportedType || notTypes.size || [...types].some((t) => t !== 'sub_frame')) return null; // $document,subdocument は同じ意味
      if (condition.initiatorDomains || condition.excludedInitiatorDomains) return null;
      allowAll = true;
      condition.resourceTypes = ['main_frame', 'sub_frame'];
    } else {
      types.add('main_frame');
    }
  }

  if (!allowAll) {
    if (unsupportedType && types.size === 0) return null;
    if (csp !== null) {
      // ページと iframe の応答だけが対象
      const list = (types.size ? [...types] : ['main_frame', 'sub_frame']).filter(
        (t) => (t === 'main_frame' || t === 'sub_frame') && !notTypes.has(t),
      );
      if (!list.length || (types.size && [...types].some((t) => t !== 'main_frame' && t !== 'sub_frame'))) return null;
      condition.resourceTypes = list;
      // $csp,domain=X は「X のドキュメント（X を直接開く・X の iframe）に CSP を付ける」という意味。
      // 判定の対象は initiator（リンク元）ではなくリクエスト先なので、initiatorDomains は requestDomains にする
      // （initiator のままだと、X を直接開く main_frame には CSP が付かない。実機で確認済み）
      if (condition.initiatorDomains) {
        if (condition.requestDomains) return null;
        condition.requestDomains = condition.initiatorDomains;
        delete condition.initiatorDomains;
      }
      if (condition.excludedInitiatorDomains) {
        if (condition.excludedRequestDomains) return null;
        condition.excludedRequestDomains = condition.excludedInitiatorDomains;
        delete condition.excludedInitiatorDomains;
      }
      if (condition.domainType === 'firstParty') delete condition.domainType; // 対象はリクエスト先そのもの。initiator との 1p 判定は要らない
    } else if (types.size) {
      const list = [...types].filter((t) => !notTypes.has(t));
      if (!list.length) return null;
      condition.resourceTypes = list;
    } else if (notTypes.size) {
      condition.excludedResourceTypes = [...notTypes];
    } else if (removeParam || regexSubstitution) {
      condition.resourceTypes = [...PARAM_DEFAULT_TYPES];
    }
  }

  if (regexFilter) {
    return {
      kind: 'network',
      allow,
      important,
      host: null,
      urlFilter: null,
      condition,
      redirect: null,
      removeParam: null,
      csp: null,
      allowAll: false,
      regexFilter,
      regexSubstitution,
    };
  }

  if (pattern === '*') pattern = '';
  if (/[^\x21-\x7e]/.test(pattern)) return null; // urlFilter は ASCII のみ
  if (pattern.startsWith('||*')) pattern = pattern.slice(2);
  const body = pattern.replace(/^\|\|?/, '').replace(/\|$/, '');
  if (body.includes('|')) return null;

  const hostMatch = DOMAIN_ONLY_RE.exec(pattern.toLowerCase());
  const host = hostMatch && HOST_RE.test(hostMatch[1]) ? hostMatch[1] : null;

  if (cosmeticSwitch) return host ? { kind: 'cosmetic-switch', host, mode: cosmeticSwitch } : null;

  // 範囲を絞る手がかりがない短すぎるパターンは、ほとんどの URL に当たってしまう
  const scoped = condition.initiatorDomains || condition.requestDomains;
  const literal = body.replace(/[*^]/g, '').length;
  if (!scoped && literal < 3) return null;
  // ページそのものを止める $document は、ドメインだけの指定（||host^）か、ある程度長い文字列のものだけ使う（誤検出するとページが開けなくなる）
  if (documentOpt && !allowAll && !host && literal < 8) return null;
  if (csp !== null && !scoped && !host && literal < 8) return null;

  return {
    kind: 'network',
    allow,
    important,
    host: host && !condition.requestDomains && !redirect && !removeParam ? host : null,
    urlFilter: pattern || null,
    condition,
    redirect,
    removeParam,
    csp,
    allowAll,
    regexFilter: null,
    regexSubstitution: null,
  };
}

/**
 * network フィルターを declarativeNetRequest のルールにする。
 * 「||example.com^」のようなドメインだけのフィルターは、同じ条件のものを requestDomains にまとめて 1 ルールにする。
 */
export function buildNetworkRules(filters, { firstId = 1, firstAllowId = ALLOW_ID_BASE, domainsPerRule = 1000 } = {}) {
  const rules = [];
  const seen = new Set();
  const bundles = new Map();
  let nextBlockId = firstId;
  let nextAllowId = firstAllowId;

  const push = (f, condition) => {
    const id = f.allow ? nextAllowId++ : nextBlockId++;
    if (!f.allow && id >= ALLOW_ID_BASE) throw new Error('ブロックルールが多すぎて ID が足りません');
    let action = { type: 'block' };
    let priority = f.important ? PRIORITY.important : PRIORITY.block;
    if (f.allow) {
      action = { type: f.allowAll ? 'allowAllRequests' : 'allow' };
      priority = PRIORITY.allow;
    } else if (f.csp) {
      // 応答の Content-Security-Policy ヘッダーに足す（ページに元からあるものは消さない）
      action = { type: 'modifyHeaders', responseHeaders: [{ header: 'content-security-policy', operation: 'append', value: f.csp }] };
    } else if (f.redirect) {
      action = { type: 'redirect', redirect: { extensionPath: f.redirect } };
      priority = f.important ? PRIORITY.important : PRIORITY.redirect;
    } else if (f.removeParam) {
      action = { type: 'redirect', redirect: { transform: { queryTransform: { removeParams: [f.removeParam] } } } };
      priority = f.important ? PRIORITY.important : PRIORITY.redirect;
    } else if (f.regexSubstitution) {
      action = { type: 'redirect', redirect: { regexSubstitution: f.regexSubstitution } };
      priority = f.important ? PRIORITY.important : PRIORITY.redirect;
    }
    rules.push({ id, priority, action, condition });
  };

  for (const f of filters) {
    if (f.host) {
      const key = JSON.stringify([f.allow, f.allowAll, f.important, f.csp, f.condition]);
      if (!bundles.has(key)) bundles.set(key, { f, hosts: new Set() });
      bundles.get(key).hosts.add(f.host);
      continue;
    }
    const condition = { ...f.condition };
    if (f.regexFilter) {
      condition.regexFilter = f.regexFilter;
      condition.isUrlFilterCaseSensitive ??= false;
    } else if (f.urlFilter) {
      condition.urlFilter = f.urlFilter;
      condition.isUrlFilterCaseSensitive ??= false;
    } else {
      delete condition.isUrlFilterCaseSensitive;
    }
    const key = JSON.stringify([f.allow, f.allowAll, f.important, f.csp, f.redirect, f.removeParam, f.regexSubstitution, condition]);
    if (seen.has(key)) continue;
    seen.add(key);
    push(f, condition);
  }

  for (const { f, hosts } of bundles.values()) {
    // 親ドメインが入っていれば子は要らない（requestDomains はサブドメインにも当たる）
    const list = [...hosts].filter((h) => !parentsOf(h).some((p) => hosts.has(p))).sort();
    const { isUrlFilterCaseSensitive, ...rest } = f.condition;
    for (let i = 0; i < list.length; i += domainsPerRule) {
      push(f, { requestDomains: list.slice(i, i + domainsPerRule), ...rest });
    }
  }
  return rules;
}

function parentsOf(host) {
  const parents = [];
  for (let i = host.indexOf('.'); i >= 0; i = host.indexOf('.', i + 1)) parents.push(host.slice(i + 1));
  return parents;
}

/** cosmetic フィルターを集めて、拡張機能が読む JSON の形にする。 */
export class CosmeticCollector {
  generic = new Set();
  genericExceptions = new Set();
  specific = new Map();
  styles = new Map();
  procedural = new Map(); // 手続き型の選択子（文字のまま。ページ側で parseProcedural する）
  exceptions = new Map();
  genericHide = new Set();
  elemHide = new Set();

  add(f) {
    if (f.kind === 'cosmetic-switch') {
      (f.mode === 'all' ? this.elemHide : this.genericHide).add(f.host);
      return;
    }
    // :style() 付きのものは「選択子:style(宣言)」の形で持つ（例外もこの形で照らし合わせる）
    const key = f.style ? `${f.selector}:style(${f.style})` : f.selector;
    if (f.exception) {
      if (!f.include.length) this.genericExceptions.add(key);
      for (const d of f.include) addTo(this.exceptions, d, key);
      return;
    }
    if (f.include.length) {
      for (const d of f.include) addTo(f.procedural ? this.procedural : f.style ? this.styles : this.specific, d, key);
    } else {
      this.generic.add(key);
    }
    for (const d of f.exclude) addTo(this.exceptions, d, key);
  }

  toJSON() {
    const classes = [];
    const ids = [];
    const complex = [];
    for (const s of this.generic) {
      if (this.genericExceptions.has(s)) continue;
      let m;
      if ((m = SIMPLE_CLASS_RE.exec(s))) classes.push(m[1]);
      else if ((m = SIMPLE_ID_RE.exec(s))) ids.push(m[1]);
      else complex.push(s);
    }
    const bySite = (map) => {
      const out = {};
      for (const [domain, keys] of sortedEntries(map)) {
        const list = [...keys].filter((s) => !this.genericExceptions.has(s));
        if (list.length) out[domain] = list;
      }
      return out;
    };
    const exceptions = {};
    for (const [domain, selectors] of sortedEntries(this.exceptions)) exceptions[domain] = [...selectors];
    return {
      classes: classes.sort(),
      ids: ids.sort(),
      complex,
      specific: bySite(this.specific),
      styles: bySite(this.styles),
      procedural: bySite(this.procedural),
      exceptions,
      genericHide: [...this.genericHide].sort(),
      elemHide: [...this.elemHide].sort(),
    };
  }
}

/**
 * スクリプレットのフィルターを集める。同じ処理（名前と引数）は entries に 1 つだけ置き、サイトからは番号で指す。
 * remove の -1 は「そのサイトではすべて止める」。
 */
export class ScriptletCollector {
  entries = [];
  index = new Map();
  add = new Map();
  remove = new Map();

  addFilter(f) {
    const i = f.name ? this.entryIndex([f.name, ...f.args]) : -1;
    if (f.exception) {
      for (const d of f.include) addTo(this.remove, d, i);
      return;
    }
    for (const d of f.include) addTo(this.add, d, i);
    for (const d of f.exclude) addTo(this.remove, d, i);
  }

  entryIndex(entry) {
    const key = JSON.stringify(entry);
    if (!this.index.has(key)) {
      this.index.set(key, this.entries.length);
      this.entries.push(entry);
    }
    return this.index.get(key);
  }

  /** スクリプトを入れる必要があるサイト。 */
  get hosts() {
    return [...this.add.keys()].sort();
  }

  toJSON() {
    const toObject = (map) => Object.fromEntries(sortedEntries(map).map(([host, set]) => [host, [...set]]));
    return { entries: this.entries, add: toObject(this.add), remove: toObject(this.remove) };
  }
}

function addTo(map, key, value) {
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(value);
}

function sortedEntries(map) {
  return [...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

// !#if の条件式（! && || と括弧）を評価する
function evalCondition(expr) {
  const tokens = expr.match(/!|&&|\|\||\(|\)|[\w-]+/g) ?? [];
  let i = 0;
  const unary = () => {
    const t = tokens[i++];
    if (t === '!') return !unary();
    if (t === '(') {
      const v = or();
      i++; // )
      return v;
    }
    return PREPROCESSOR_ENV[t] === true;
  };
  const and = () => {
    let v = unary();
    while (tokens[i] === '&&') {
      i++;
      v = unary() && v;
    }
    return v;
  };
  const or = () => {
    let v = and();
    while (tokens[i] === '||') {
      i++;
      v = and() || v;
    }
    return v;
  };
  return or();
}

/** フィルターの行だけを取り出す。コメントを除き、!#if ... !#else ... !#endif はこの拡張機能に合う側だけを残す。 */
export function* filterLines(text) {
  const blocks = [];
  let active = true;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('!#if ')) {
      const cond = evalCondition(line.slice(5));
      blocks.push({ outer: active, cond });
      active &&= cond;
      continue;
    }
    if (line.startsWith('!#else')) {
      const b = blocks.at(-1);
      if (b) active = b.outer && !b.cond;
      continue;
    }
    if (line.startsWith('!#endif')) {
      const b = blocks.pop();
      if (b) active = b.outer;
      continue;
    }
    if (!active || !line || line.startsWith('!') || line.startsWith('[') || line.startsWith('# ')) continue;
    yield line;
  }
}

/**
 * $badfilter の付いた行を探し、打ち消す対象のフィルター（badfilter を除いた形）を返す。
 * 別のリストのフィルターを打ち消すことがあるので、tools/build-filters.mjs がすべてのリストから先に集める。
 */
export function findBadfilters(text) {
  const out = [];
  for (const line of filterLines(text)) {
    const dollar = line.lastIndexOf('$');
    if (dollar < 0) continue;
    const options = line.slice(dollar + 1).split(',');
    if (!options.includes('badfilter')) continue;
    const rest = options.filter((o) => o !== 'badfilter');
    out.push(rest.length ? `${line.slice(0, dollar)}$${rest.join(',')}` : line.slice(0, dollar));
  }
  return out;
}

// 1 つのリストが使える正規表現ルール（regexFilter）の数。DNR の上限（拡張機能全体で 1000 件）をリストで分け合う
export const MAX_REGEX_RULES_PER_LIST = 200;

/**
 * フィルターリストの文章全体を変換する。
 * options: buildNetworkRules に渡す ID の設定と、badfilters（打ち消されたフィルターの Set）、maxRegexRules（正規表現ルールの上限）
 */
export function compileFilterList(text, { badfilters, maxRegexRules = MAX_REGEX_RULES_PER_LIST, ...ruleOptions } = {}) {
  const network = [];
  const cosmetic = new CosmeticCollector();
  const scriptlets = new ScriptletCollector();
  const stats = { network: 0, cosmetic: 0, scriptlet: 0, skipped: 0 };
  let regexCount = 0;
  for (const line of filterLines(text)) {
    if (badfilters?.has(line)) continue;
    let f = parseFilter(line);
    // 正規表現のルールは拡張機能全体で 1000 件まで。1 つのリストが使いすぎないように数える
    if (f?.regexFilter) {
      if (regexCount >= maxRegexRules) f = null;
      else regexCount++;
    }
    if (!f) {
      if (!/[$,]badfilter(,|$)/.test(line)) stats.skipped++;
    } else if (f.kind === 'network') {
      network.push(f);
      stats.network++;
    } else if (f.kind === 'scriptlet') {
      scriptlets.addFilter(f);
      stats.scriptlet++;
    } else {
      cosmetic.add(f);
      stats.cosmetic++;
    }
  }
  return { rules: buildNetworkRules(network, ruleOptions), cosmetic: cosmetic.toJSON(), scriptlets, stats };
}
