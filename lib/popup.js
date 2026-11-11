// フィルターの $popup（広告のポップアップ・ポップアンダー）を扱う。
// declarativeNetRequest ではポップアップだけを区別できないので、service worker（popup-blocker.js）が
// 新しく開かれたタブの URL をこのモジュールの判定に通し、一致したらタブを閉じる。
//   - 変換（ビルド時・自分で書いたフィルター）: parsePopupFilter / compilePopupLines / compilePopupText
//   - 判定（実行時）: PopupMatcher
// chrome API には依存しないので、Node で単体テストできる。
//
// 変換後のデータ（1 つのリスト分）:
//   { b: Side, a: Side }   b = ブロック（$popup）、a = 例外（@@...$popup）。空の側は省く
//   Side = { h: {ホスト名: 項目の配列 | 0}, p: [項目], r: [項目] }
//     h … ||host^ や ||host/path のように、ホスト名で始まるパターン。0 は「そのホストなら何でも」
//     p … それ以外の ABP のパターン（* ^ | を含む）
//     r … /正規表現/
//   項目 = パターン文字列（条件なし）、または [パターン文字列 | 0, 条件]
//     h の項目のパターンは、ホスト名より後ろの部分（例 "/next^"）。p と r は URL 全体に対するもの
//   条件 = { d: [元ページのドメイン], x: [除外する元ページのドメイン], o: [開く先のドメイン], y: [除外する開く先],
//            t: 1（サードパーティのみ）| 0（ファーストパーティのみ）, i: 1（important）, c: 1（大文字小文字を区別） }
//     ドメインの "example.*" は、ENTITY_TLDS などの TLD に当てはまるホストに一致する。

import { ENTITY_TLDS } from './entity-tlds.js';
import { filterLines } from './filters.js';
import { hostChain } from './hosts.js';

// popup 以外のタイプ指定。$popup,subdocument のように併記されていても、popup の部分だけを使うので読み飛ばす
const IGNORED_TYPES = new Set([
  'script', 'image', 'stylesheet', 'css', 'object', 'object-subrequest', 'xmlhttprequest', 'xhr', 'subdocument', 'frame',
  'media', 'font', 'websocket', 'ping', 'beacon', 'other', 'document', 'doc', 'webrtc', 'webtransport', 'all',
  'inline-script', 'inline-font',
]);

// ---- 変換 ----

// 末尾の $options を切り分ける（右端の $ より後ろがオプションとして読めるときだけ）。
function splitOptions(line) {
  const i = line.lastIndexOf('$');
  const text = line.slice(i + 1);
  if (i < 0 || !/^~?[a-z0-9-]+(=[^,]*)?(,~?[a-z0-9-]+(=[^,]*)?)*$/i.test(text)) return null;
  return { pattern: line.slice(0, i), optionText: text };
}

function normalizeHost(d) {
  if (/^[a-z0-9._-]+$/.test(d)) return d;
  try {
    const host = new URL(`http://${d}`).hostname; // 国際化ドメインは punycode にする
    return /^[a-z0-9._-]+$/.test(host) ? host : '';
  } catch {
    return '';
  }
}

// "a.com|~b.com|c.*" → { include, exclude }。使えない書き方があれば { error }。
// 除外の指定を落とすと止めすぎるので、読めない除外が 1 つでもあればフィルターごと捨てる。含める側は、読めたものだけ残す。
function parseDomains(value) {
  const include = [];
  const exclude = [];
  for (const raw of value.toLowerCase().split('|')) {
    const neg = raw.startsWith('~');
    const d = (neg ? raw.slice(1) : raw).replace(/^\*\./, '');
    let host = '';
    let entity = false;
    if (d.endsWith('.*')) {
      host = d.slice(0, -2).includes('*') ? '' : normalizeHost(d.slice(0, -2));
      entity = true;
    } else if (!d.includes('*') && !d.startsWith('/')) {
      host = normalizeHost(d);
    }
    if (!host) {
      if (neg) return { error: 'domain の読めない除外指定' };
      continue;
    }
    (neg ? exclude : include).push(entity ? `${host}.*` : host);
  }
  if (!include.length && !exclude.length) return { error: 'domain の指定が読めない（正規表現など）' };
  return { include, exclude };
}

// ABP のパターンの記号（* ^ | ||）を正規表現にする。^ は「英数字と _ - . % 以外の 1 文字、または URL の終わり」
const SEPARATOR = '(?:[^\\w.%-]|$)';
const ESCAPE_RE = /[.+?(){}[\]\\/$|]/g;
export function patternToRegexSource(pattern) {
  let p = pattern;
  let src = '';
  if (p.startsWith('||')) {
    src = '^[a-z][a-z0-9+.-]*:\\/\\/(?:[^\\/?#]*[.@])?';
    p = p.slice(2);
  } else if (p.startsWith('|')) {
    src = '^';
    p = p.slice(1);
  }
  const end = p.endsWith('|');
  if (end) p = p.slice(0, -1);
  if (!src) p = p.replace(/^\*+/, '');
  if (!end) p = p.replace(/\*+$/, '');
  let star = false;
  for (const ch of p) {
    if (ch === '*') {
      if (!star) src += '.*';
      star = true;
      continue;
    }
    star = false;
    src += ch === '^' ? SEPARATOR : ch.replace(ESCAPE_RE, '\\$&');
  }
  return end ? `${src}$` : src;
}

const hasLiteral = (pattern) => /[^*^|]/.test(pattern);

/**
 * フィルター 1 行を読む。
 * 戻り値: null（$popup のない行。別の処理の担当）
 *        { drop: 理由 }（$popup だが対応できない）
 *        { filter }（filter = { exception, kind: 'h'|'p'|'r', host?, text, opts }）
 */
export function parsePopupFilter(line) {
  let rest = line.trim();
  const exception = rest.startsWith('@@');
  if (exception) rest = rest.slice(2);
  const split = splitOptions(rest);
  if (!split) return null;
  const { pattern: rawPattern, optionText } = split;

  const opts = {};
  let popup = false;
  let drop = null; // 対応できないオプションがあっても、$popup の行かどうかは最後まで読まないと分からない
  for (const raw of optionText.split(',')) {
    const negated = raw.startsWith('~');
    const option = negated ? raw.slice(1) : raw;
    const eq = option.indexOf('=');
    const name = (eq < 0 ? option : option.slice(0, eq)).trim().toLowerCase();
    const value = eq < 0 ? '' : option.slice(eq + 1);
    switch (name) {
      case 'popup':
        if (negated) return null; // ~popup は「ポップアップ以外」
        popup = true;
        break;
      case 'badfilter':
        return null; // 打ち消す対象は findBadfilters が集めて、変換のときに除く
      case 'third-party':
      case '3p':
        opts.t = negated ? 0 : 1;
        break;
      case 'first-party':
      case '1p':
        opts.t = negated ? 1 : 0;
        break;
      case 'match-case':
        if (negated) drop ??= 'match-case の否定';
        opts.c = 1;
        break;
      case 'important':
        if (negated) drop ??= 'important の否定';
        opts.i = 1;
        break;
      case 'domain':
      case 'from': {
        const d = parseDomains(value);
        if (d.error || negated) drop ??= d.error ?? 'domain の否定';
        else if (d.include.length) opts.d = d.include;
        if (!d.error && !negated && d.exclude.length) opts.x = d.exclude;
        break;
      }
      case 'to': {
        const d = parseDomains(value);
        if (d.error || negated) drop ??= d.error ? 'to の指定が読めない' : 'to の否定';
        else if (d.include.length) opts.o = d.include;
        if (!d.error && !negated && d.exclude.length) opts.y = d.exclude;
        break;
      }
      default:
        if (!IGNORED_TYPES.has(name)) drop ??= `未対応のオプション: ${name}`;
    }
  }
  if (!popup) return null;
  if (drop) return { drop };

  // パターン
  let pattern = rawPattern;
  if (pattern.length > 1 && pattern.startsWith('/') && pattern.endsWith('/')) {
    const source = pattern.slice(1, -1);
    if (source.length > 1000) return { drop: '長すぎる正規表現' };
    try {
      new RegExp(source, 'i');
    } catch {
      return { drop: '正規表現が JavaScript で読めない' };
    }
    if (/\\[1-9k]|\(\?<[A-Za-z_]/.test(source)) return { drop: '後方参照・名前付きグループの正規表現' };
    return { filter: { exception, kind: 'r', text: source, opts } };
  }
  if (!opts.c) pattern = pattern.toLowerCase();
  if (!hasLiteral(pattern)) {
    // $popup,domain=... のように、パターンなしで条件だけのもの。条件もなければ全ポップアップを閉じてしまうので使わない
    if (!Object.keys(opts).length) return { drop: '条件のない全ポップアップ' };
    return { filter: { exception, kind: 'p', text: '*', opts } };
  }
  const hostMatch = /^\|\|([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?=[\^/:?]|$)(.*)$/s.exec(pattern);
  if (hostMatch) {
    const after = hostMatch[2].replace(/\*+$/, '');
    return { filter: { exception, kind: 'h', host: hostMatch[1], text: after === '^' ? '' : after, opts } };
  }
  return { filter: { exception, kind: 'p', text: pattern, opts } };
}

const emptySide = () => ({ h: {}, p: [], r: [] });

function addToSide(side, f) {
  const hasOpts = Object.keys(f.opts).length > 0;
  const push = (list, item) => {
    const key = JSON.stringify(item);
    if (!list.some((x) => JSON.stringify(x) === key)) list.push(item);
  };
  if (f.kind === 'h') {
    if (side.h[f.host] === 0) return;
    if (!f.text && !hasOpts) {
      side.h[f.host] = 0;
      return;
    }
    side.h[f.host] ??= [];
    push(side.h[f.host], hasOpts ? [f.text || 0, f.opts] : f.text);
    return;
  }
  push(f.kind === 'p' ? side.p : side.r, hasOpts ? [f.text, f.opts] : f.text);
}

const trimSide = (side) => {
  const out = {};
  if (Object.keys(side.h).length) out.h = side.h;
  if (side.p.length) out.p = side.p;
  if (side.r.length) out.r = side.r;
  return Object.keys(out).length ? out : null;
};

/**
 * フィルターの行（filterLines の結果）を、1 つのリスト分のデータにする。
 * badfilters: 打ち消されたフィルターの行の Set（findBadfilters）。
 * 戻り値: { data, stats: { block, allow, dropped: { 理由: 件数 } } }
 */
export function compilePopupLines(lines, { badfilters } = {}) {
  const b = emptySide();
  const a = emptySide();
  const stats = { block: 0, allow: 0, dropped: {} };
  for (const line of lines) {
    if (badfilters?.has(line)) continue;
    const r = parsePopupFilter(line);
    if (!r) continue;
    if (r.drop) {
      stats.dropped[r.drop] = (stats.dropped[r.drop] ?? 0) + 1;
      continue;
    }
    addToSide(r.filter.exception ? a : b, r.filter);
    stats[r.filter.exception ? 'allow' : 'block']++;
  }
  const data = {};
  const bs = trimSide(b);
  const as = trimSide(a);
  if (bs) data.b = bs;
  if (as) data.a = as;
  return { data, stats };
}

/** フィルターリストの文章全体から。 */
export const compilePopupText = (text, options) => compilePopupLines(filterLines(text), options);

// ---- 判定 ----

const TLD_SET = new Set(ENTITY_TLDS);
const SECOND_LEVEL_RE = /^(?:co|com|org|net|ne|or|ac|go|gov|edu|ed|gr|lg)\.[a-z]{2}$/;
const IP_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[.*\])$/;

/** サードパーティの判定に使う、登録可能なドメイン（簡易版。公開サフィックスの一覧は持たない）。 */
export function registrableDomain(host) {
  if (!host || IP_RE.test(host)) return host;
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const last2 = labels.slice(-2).join('.');
  return labels.slice(SECOND_LEVEL_RE.test(last2) ? -3 : -2).join('.');
}

function entityMatches(base, host) {
  const s = `.${host}`;
  const needle = `.${base}.`;
  for (let i = s.indexOf(needle); i >= 0; i = s.indexOf(needle, i + 1)) {
    const rest = s.slice(i + needle.length);
    if (TLD_SET.has(rest) || SECOND_LEVEL_RE.test(rest)) return true;
  }
  return false;
}

// ドメインの一覧に host（またはその親ドメイン）が入っているか。"example.*" は TLD を補って比べる
function listHas(list, host, cache) {
  let prepared = cache.get(list);
  if (!prepared) {
    prepared = {
      plain: new Set(list.filter((d) => !d.endsWith('.*'))),
      entities: list.filter((d) => d.endsWith('.*')).map((d) => d.slice(0, -2)),
    };
    cache.set(list, prepared);
  }
  return hostChain(host).some((h) => prepared.plain.has(h)) || prepared.entities.some((e) => entityMatches(e, host));
}

/** 判定に使う URL の情報。http(s) 以外は null。 */
export function describeUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return { href: u.href, host: u.hostname, after: (u.port ? `:${u.port}` : '') + u.pathname + u.search + u.hash };
  } catch {
    return null;
  }
}

const CHUNK = 250; // まとめる正規表現 1 つあたりのパターン数

// データの 1 つの側（b か a）を、判定に使える形にする。正規表現は、最初に使うときまで作らない
function prepareSide(side) {
  const plainSources = [];
  const condSpecs = [];
  for (const item of side.p ?? []) {
    if (typeof item === 'string') plainSources.push(patternToRegexSource(item));
    else condSpecs.push({ source: patternToRegexSource(item[0]), opts: item[1] });
  }
  for (const item of side.r ?? []) {
    if (typeof item === 'string') condSpecs.push({ source: item, opts: null });
    else condSpecs.push({ source: item[0], opts: item[1] });
  }
  let plainRes = null;
  return {
    h: side.h ?? {},
    get plain() {
      plainRes ??= Array.from({ length: Math.ceil(plainSources.length / CHUNK) }, (_, k) => {
        const part = plainSources.slice(k * CHUNK, (k + 1) * CHUNK);
        return new RegExp(part.map((s) => `(?:${s})`).join('|'), 'i');
      });
      return plainRes;
    },
    cond: condSpecs.map((spec) => {
      let re;
      return {
        opts: spec.opts,
        get re() {
          return (re ??= new RegExp(spec.source, spec.opts?.c ? '' : 'i'));
        },
      };
    }),
  };
}

/**
 * 変換済みのデータ（複数のリスト分）で、ポップアップの URL を判定する。
 *   match(url, sourceUrl) → 'block'（閉じる）| 'allow'（例外に当たったので閉じない）| null（一致なし）
 * ブロックのフィルターが 1 つも当たらなければ、例外は調べない（速くするため）。
 * 元のページ（sourceUrl）が分からないときは、元のページ・サードパーティの条件がある項目には一致しない。
 */
export class PopupMatcher {
  constructor(lists) {
    this.sides = { b: [], a: [] };
    for (const data of lists) {
      for (const key of ['b', 'a']) if (data?.[key]) this.sides[key].push(prepareSide(data[key]));
    }
    this.domainCache = new WeakMap();
    this.restCache = new Map();
  }

  get size() {
    return this.sides.b.length + this.sides.a.length;
  }

  match(url, sourceUrl) {
    const target = describeUrl(url);
    if (!target) return null;
    const ctx = { target, sourceHost: describeUrl(sourceUrl)?.host ?? '' };
    let blocked = false;
    for (const side of this.sides.b) {
      const r = this.#side(side, ctx);
      if (r === 'important') return 'block';
      if (r) blocked = true;
    }
    if (!blocked) return null;
    for (const side of this.sides.a) if (this.#side(side, ctx)) return 'allow';
    return 'block';
  }

  // 'important' | 'normal' | null
  #side(side, ctx) {
    const { target } = ctx;
    let hit = null;
    // ホスト名ごとの表
    for (const h of hostChain(target.host)) {
      const items = side.h[h];
      if (items === undefined) continue;
      if (items === 0) {
        hit = 'normal';
        continue;
      }
      for (const item of items) {
        const [rest, opts] = typeof item === 'string' ? [item, null] : item;
        if (rest && !this.#rest(rest).test(target.after)) continue;
        if (opts && !this.#opts(opts, ctx)) continue;
        if (opts?.i) return 'important';
        hit = 'normal';
      }
    }
    // 条件のない ABP のパターン（まとめた正規表現）
    if (!hit) {
      for (const re of side.plain) {
        if (re.test(target.href)) {
          hit = 'normal';
          break;
        }
      }
    }
    // 条件付きのパターンと正規表現
    for (const entry of side.cond) {
      if (!entry.re.test(target.href)) continue;
      if (entry.opts && !this.#opts(entry.opts, ctx)) continue;
      if (entry.opts?.i) return 'important';
      hit = 'normal';
    }
    return hit;
  }

  #rest(text) {
    let re = this.restCache.get(text);
    if (!re) {
      re = new RegExp(patternToRegexSource(`|${text}`), 'i');
      this.restCache.set(text, re);
    }
    return re;
  }

  #opts(opts, ctx) {
    const { target, sourceHost } = ctx;
    if (opts.t !== undefined) {
      if (!sourceHost) return false;
      const third = registrableDomain(sourceHost) !== registrableDomain(target.host);
      if (third !== (opts.t === 1)) return false;
    }
    if (opts.d || opts.x) {
      if (!sourceHost) return false;
      if (opts.d && !listHas(opts.d, sourceHost, this.domainCache)) return false;
      if (opts.x && listHas(opts.x, sourceHost, this.domainCache)) return false;
    }
    if (opts.o && !listHas(opts.o, target.host, this.domainCache)) return false;
    if (opts.y && listHas(opts.y, target.host, this.domainCache)) return false;
    return true;
  }
}
