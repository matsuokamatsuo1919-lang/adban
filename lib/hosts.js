// ホスト名まわりの小さな関数。service worker・ポップアップ・設定画面で共有する。

/** http(s) の URL からホスト名を取り出す。それ以外は空文字。 */
export function hostOf(url) {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ? hostname : '';
  } catch {
    return '';
  }
}

/** a.b.example.com → [a.b.example.com, b.example.com, example.com, com] */
export function hostChain(host) {
  const chain = [];
  let h = host;
  while (h) {
    chain.push(h);
    const dot = h.indexOf('.');
    if (dot < 0) break;
    h = h.slice(dot + 1);
  }
  return chain;
}

/** 許可リストなどに登録するときの形（先頭の www. を外す）。 */
export function siteKey(host) {
  return host.replace(/^www\./, '');
}

/** host そのもの、またはその親ドメインが list に入っているか。 */
export function isListed(list, host) {
  if (!host) return false;
  const set = list instanceof Set ? list : new Set(list);
  return hostChain(host).some((h) => set.has(h));
}

/** 人が入力したドメイン（URL でもよい）を、ルールに使える形にそろえる。使えなければ空文字。 */
export function normalizeDomain(text) {
  let s = text.trim().toLowerCase();
  if (!s) return '';
  if (!s.includes('://')) s = `http://${s}`;
  let host;
  try {
    host = new URL(s).hostname; // 国際化ドメインは punycode になる
  } catch {
    return '';
  }
  host = host.replace(/^\*\./, '').replace(/\.$/, '');
  return /^[a-z0-9_-]+(\.[a-z0-9_-]+)+$/.test(host) ? host : '';
}

// 公開サフィックスの簡易判定（example.* のようなエンティティ指定のため）。
// 公開サフィックス一覧（PSL）は大きいので持たず、次のように判断する:
//   ・最後の 1 ラベル（com, jp, de, xn--…）はサフィックス
//   ・最後が 2 文字の国別コードで、その前が co / com / ne / or / ac / go / ed / gov / edu / org / net などなら、2 ラベルをサフィックスとする（co.jp, com.au, co.uk …）
// 限界: PSL にあるそれ以外の 2 ラベル以上（asso.fr, k12.ma.us, github.io など）は 1 ラベルとして扱う。
//   その場合は example.asso.fr の「example」を見つけられず、エンティティのフィルターは効かない（範囲が広がることはない）。
const SECOND_LEVEL_LABELS = new Set(['co', 'com', 'ne', 'or', 'ac', 'go', 'ed', 'gov', 'edu', 'org', 'net', 'gr', 'lg', 'mil', 'nom', 'sch']);
const TLD_RE = /^(?:[a-z]{2,24}|xn--[a-z0-9-]+)$/;

/**
 * www.example.co.jp → ['www.example.*', 'example.*']。エンティティ（example.*）の指定がこのホストに当たるかを調べるときの鍵。
 * IP アドレス・ラベルが 1 つだけのホスト名では空。
 */
export function entityChain(host) {
  if (!host || host.includes(':')) return [];
  const labels = host.split('.');
  const n = labels.length;
  if (n < 2 || !TLD_RE.test(labels[n - 1])) return [];
  const suffix = n >= 3 && labels[n - 1].length === 2 && SECOND_LEVEL_LABELS.has(labels[n - 2]) ? 2 : 1;
  const rest = labels.slice(0, n - suffix);
  const chain = [];
  for (let i = 0; i < rest.length; i++) chain.push(`${rest.slice(i).join('.')}.*`);
  return chain;
}
