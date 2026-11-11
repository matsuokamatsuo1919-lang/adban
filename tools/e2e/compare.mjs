// 2 つの計測結果(out/<日時>)を比べて compare.md を作る。改善・悪化は色ではなく文字で書く。
// 使い方: node tools/e2e/compare.mjs <前の out> <後の out> [--out <compare.md の出力先ディレクトリ(既定: 後の out)>]
// 片方に無い指標(古い結果には「差し替え」「空の広告枠」が無い)は N/A と書く。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const NOISE = 2; // 件数の変化がこれ以下なら「変化小」(広告の出方は実行ごとに揺れる)

function load(dir) {
  const f = fs.statSync(dir).isDirectory() ? path.join(dir, 'report.json') : dir;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

// 指標の定義: 取り出し方と、良い方向(lower: 少ないほど良い / higher / one: 1 に近いほど良い)
const METRICS = [
  { key: 'blocked', label: '止めた数', good: 'higher', get: (s) => s.adban?.net?.blocked },
  { key: 'replaced', label: '差し替えた数', good: 'higher', get: (s) => s.adban?.net?.replaced },
  { key: 'passed', label: '通過(第三者)', good: 'lower', get: (s) => s.adban?.net?.passedThird },
  { key: 'adlike', label: '残った広告らしい要素', good: 'lower', get: (s) => (s.adban?.dom ? s.adban.dom.adIframes + s.adban.dom.adElems : undefined) },
  { key: 'empty', label: '空の広告枠', good: 'lower', get: (s) => s.adban?.dom?.emptyAdSlots },
  { key: 'ratio', label: '本文長比', good: 'one', ratio: true, get: (s) => (s.baseline?.dom && s.adban?.dom && s.baseline.dom.textLen > 0 ? s.adban.dom.textLen / s.baseline.dom.textLen : undefined) },
  { key: 'console', label: 'コンソールエラー', good: 'lower', get: (s) => s.adban?.console?.errors },
];

function judge(m, a, b) {
  if (a == null || b == null) return 'N/A';
  if (m.good === 'one') {
    const da = Math.abs(1 - a), db = Math.abs(1 - b);
    if (Math.abs(da - db) < 0.05) return '変化小';
    return db < da ? '改善' : '悪化';
  }
  const d = b - a;
  if (d === 0) return '同じ';
  if (Math.abs(d) <= NOISE) return '変化小';
  const better = m.good === 'higher' ? d > 0 : d < 0;
  return better ? '改善' : '悪化';
}

const f = (v, ratio) => (v == null ? 'N/A' : ratio ? v.toFixed(2) : String(v));
const cell = (m, a, b) => {
  const j = judge(m, a, b);
  if (a == null && b == null) return 'N/A';
  const d = a != null && b != null ? (m.ratio ? (b - a).toFixed(2) : String(b - a)) : '';
  return `${f(a, m.ratio)} -> ${f(b, m.ratio)}${d !== '' && d !== '0' && d !== '0.00' ? ` (${d.startsWith('-') ? d : '+' + d})` : ''} [${j}]`;
};

export function compare(before, after, labels = {}) {
  const L = [];
  const bm = new Map(before.sites.map((s) => [s.url, s]));
  const common = after.sites.filter((s) => bm.has(s.url));
  L.push('# ADBAN 計測の比較', '');
  L.push(`- 前: ${labels.before || ''}(${before.meta?.startedAt || '?'}、拡張機能 v${before.meta?.adban?.ext?.version ?? '?'})`);
  L.push(`- 後: ${labels.after || ''}(${after.meta?.startedAt || '?'}、拡張機能 v${after.meta?.adban?.ext?.version ?? '?'})`);
  L.push(`- 共通のサイト: ${common.length}(前のみ ${before.sites.filter((s) => !after.sites.some((x) => x.url === s.url)).length}、後のみ ${after.sites.filter((s) => !bm.has(s.url)).length})`);
  L.push(`- 判定の基準: 止めた数・差し替えた数は増えると「改善」、通過・広告らしい要素・空の広告枠・コンソールエラーは減ると「改善」、本文長比は 1 に近づくと「改善」。件数の変化が ${NOISE} 以下、本文長比が 0.05 未満の変化は「変化小」(実行ごとの揺れの範囲)。前に無い指標は N/A。`);
  L.push('');

  // 合計(共通サイト)
  L.push('## 合計(共通サイト、adban)', '');
  L.push('| 指標 | 前 | 後 | 差 | 判定 | 改善 / 悪化 したサイト数 |', '|---|---:|---:|---:|---|---|');
  for (const m of METRICS) {
    if (m.ratio) {
      const rs = (sel) => common.map((s) => sel(s)).filter((x) => x != null).sort((x, y) => x - y);
      const med = (a) => (a.length ? a[a.length >> 1] : null);
      const a = med(rs((s) => m.get(bm.get(s.url)))), b = med(rs(m.get));
      L.push(`| ${m.label}(中央値) | ${f(a, true)} | ${f(b, true)} | ${a != null && b != null ? (b - a).toFixed(2) : 'N/A'} | ${judge(m, a, b)} | |`);
      continue;
    }
    const pairs = common.map((s) => [m.get(bm.get(s.url)), m.get(s)]);
    const valid = pairs.filter(([x, y]) => x != null && y != null);
    const a = valid.length ? valid.reduce((t, [x]) => t + x, 0) : null;
    const b = valid.length ? valid.reduce((t, [, y]) => t + y, 0) : null;
    const better = valid.filter(([x, y]) => judge(m, x, y) === '改善').length;
    const worse = valid.filter(([x, y]) => judge(m, x, y) === '悪化').length;
    L.push(`| ${m.label} | ${f(a)} | ${f(b)} | ${a != null ? b - a : 'N/A'} | ${a != null ? (b - a === 0 ? '同じ' : judge(m, a, b) === '変化小' ? '変化小' : (m.good === 'higher' ? b > a : b < a) ? '改善' : '悪化') : 'N/A'} | ${valid.length ? `${better} / ${worse}` : 'N/A'} |`);
  }
  L.push('');

  // サイトごと(変化のあるものだけ)
  L.push('## サイトごとの差分(adban。「同じ」「変化小」だけのサイトは省略)', '');
  L.push('| サイト | ' + METRICS.map((m) => m.label).join(' | ') + ' |', '|---|' + METRICS.map(() => '---').join('|') + '|');
  let shown = 0;
  for (const s of common) {
    const o = bm.get(s.url);
    const js = METRICS.map((m) => judge(m, m.get(o), m.get(s)));
    if (!js.some((j) => j === '改善' || j === '悪化')) continue;
    shown++;
    L.push(`| ${s.url.replace(/^https?:\/\//, '').replace(/\/$/, '')} | ` + METRICS.map((m) => cell(m, m.get(o), m.get(s))).join(' | ') + ' |');
  }
  if (!shown) L.push('| (改善・悪化したサイトなし) |' + METRICS.map(() => '').join('|') + '|');
  L.push('');

  // 検出ページ
  L.push('## 検出ページ', '');
  const bd = new Map((before.detectors || []).map((d) => [d.name, d]));
  if (after.detectors?.length) {
    L.push('| ページ | 前(adban) | 後(adban) | 点数 前 -> 後 | 判定 |', '|---|---|---|---|---|');
    for (const d of after.detectors) {
      const o = bd.get(d.name);
      if (!o) { L.push(`| ${d.name} | (前に無い) | ${d.adban?.text || '-'} | N/A | N/A |`); continue; }
      const pa = o.adban?.pct, pb = d.adban?.pct;
      let j = 'N/A';
      if (pa != null && pb != null) j = pb === pa ? '同じ' : pb > pa ? '改善' : '悪化';
      else if ((o.adban?.text || '') === (d.adban?.text || '')) j = '同じ';
      else j = '変化あり(結果の文面を見ること)';
      L.push(`| ${d.name} | ${(o.adban?.text || '-').replace(/\|/g, '/')} | ${(d.adban?.text || '-').replace(/\|/g, '/')} | ${pa ?? 'N/A'} -> ${pb ?? 'N/A'} | ${j} |`);
    }
    L.push('');
    for (const d of after.detectors) {
      const o = bd.get(d.name);
      if (!o?.adban?.items?.length || !d.adban?.items?.length) continue;
      const om = new Map(o.adban.items.map((i) => [i.group + '|' + i.name, i.status]));
      const nowBlocked = [], nowOpen = [];
      for (const i of d.adban.items) {
        const prev = om.get(i.group + '|' + i.name);
        if (prev && prev !== i.status) (/^blocked$/i.test(i.status) ? nowBlocked : nowOpen).push(`${i.group}: ${i.name}`);
      }
      if (nowBlocked.length || nowOpen.length) {
        L.push(`### ${d.name}: 項目の変化`, '');
        L.push(`- 新しく止められた(改善): ${nowBlocked.length ? nowBlocked.join(' / ') : 'なし'}`);
        L.push(`- 止められなくなった(悪化): ${nowOpen.length ? nowOpen.join(' / ') : 'なし'}`, '');
      }
    }
  } else L.push('(後の結果に検出ページなし)', '');
  L.push('');

  // YouTube
  L.push('## YouTube', '');
  const ya = before.youtube, yb = after.youtube;
  if (Array.isArray(yb)) {
    const prev = new Map((Array.isArray(ya) ? ya : []).map((v) => [v.url, v]));
    L.push('| 動画 | 比較可(後) | adban の広告秒 前 -> 後 | 広告ブロッカー警告 前 -> 後 | 判定 |', '|---|---|---|---|---|');
    for (const v of yb) {
      const o = prev.get(v.url);
      const sa = o?.adban?.summary, sb = v.adban?.summary;
      const warn = (x) => (x ? (x.adblockWarning ? 'あり' : 'なし') : 'N/A');
      let j = 'N/A';
      if (sa && sb && o.comparable && v.comparable) j = sb.anyAdSeconds === sa.anyAdSeconds ? '同じ' : sb.anyAdSeconds < sa.anyAdSeconds ? '改善' : '悪化';
      else if (!v.comparable) j = '比較にならない(baseline に広告なし)';
      L.push(`| ${v.label} | ${v.comparable ? '○' : '×'} | ${sa ? sa.anyAdSeconds : 'N/A'} -> ${sb ? sb.anyAdSeconds : 'N/A'} | ${warn(sa)} -> ${warn(sb)} | ${j} |`);
    }
  } else L.push('(後の結果に YouTube なし)');
  L.push('');
  return L.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2).filter((a, i, arr) => !a.startsWith('--') && !(i > 0 && arr[i - 1] === '--out'));
  if (args.length < 2) { console.error('使い方: node tools/e2e/compare.mjs <前の out> <後の out>'); process.exit(2); }
  const [b, a] = args.map((x) => path.resolve(x));
  const oi = process.argv.indexOf('--out');
  const outDir = oi >= 0 ? path.resolve(process.argv[oi + 1]) : a;
  const md = compare(load(b), load(a), { before: path.basename(b), after: path.basename(a) });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'compare.md'), md);
  console.log(md);
  console.log('出力:', path.join(outDir, 'compare.md'));
}
