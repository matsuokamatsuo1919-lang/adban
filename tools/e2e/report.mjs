// report.json / report.md を作る。単体実行: node tools/e2e/report.mjs <出力ディレクトリ>(report.json から report.md を作り直す)
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 広告・トラッカーらしいホスト名
const AD_HOST = /(^|[.\-])(ads?|adserver|adservice|adsystem|adnxs|adform|adition|adtech|adroll|doubleclick|googlesyndication|googleadservices|taboola|outbrain|criteo|pubmatic|rubiconproject|openx|casalemedia|indexww|3lift|smartadserver|moatads|scorecardresearch|quantserve|krxd|bluekai|demdex|tapad|bidswitch|sharethrough|teads|amazon-adsystem|yieldmo|media\.net|adsrvr|rlcdn|id5-sync|liveramp|permutive|lijit|sovrn|gumgum|33across|contextweb|adingo|i-mobile|microad|fluct|logly|gunosy|nend|socdm|impact-ad|yjtag|yads|yimg\.jp\/images\/advertising|adstir|zucks|geniee|ssp|dsp|rtb|tracking|tracker|analytics|pixel|beacon|metrics|stats|telemetry|hotjar|clarity|segment|mixpanel|amplitude|branch|appsflyer|adjust|facebook|fbcdn|twitter|ads-twitter|tiktok|snap|linkedin|pinterest)([.\-]|$)/i;
const AD_HOST2 = /(adservice|googletagmanager|googletagservices|google-analytics|googleadservices|doubleclick|googlesyndication|analytics|adsystem|adnxs|criteo|taboola|outbrain)/i;

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
const adLike = (m) => (m?.dom ? m.dom.adIframes + m.dom.adElems : null);
const fmt = (v) => (v == null ? '-' : v);
const median = (a) => { const s = a.filter((x) => x != null && isFinite(x)).sort((x, y) => x - y); if (!s.length) return null; const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const sum = (a) => a.reduce((x, y) => x + (y || 0), 0);

export function siteRow(site) {
  const b = site.baseline, a = site.adban;
  const ratio = b?.dom && a?.dom && b.dom.textLen > 0 ? a.dom.textLen / b.dom.textLen : null;
  const n = (m, k) => (m?.net ? (m.net[k] ?? null) : null);
  return {
    url: site.url, category: site.category, note: site.note,
    reqB: n(b, 'total'), reqA: n(a, 'total'),
    blockedB: n(b, 'blocked'), blockedA: n(a, 'blocked'),
    replacedB: n(b, 'replaced'), replacedA: n(a, 'replaced'),
    passedB: n(b, 'passedThird'), passedA: n(a, 'passedThird'),
    adLikeB: adLike(b), adLikeA: adLike(a),
    emptyB: b?.dom?.emptyAdSlots ?? null, emptyA: a?.dom?.emptyAdSlots ?? null,
    textRatio: ratio,
    consoleB: b?.console?.errors ?? null, consoleA: a?.console?.errors ?? null,
    detectB: b?.dom?.detectMessages ?? [], detectA: a?.dom?.detectMessages ?? [],
    lockedA: a?.dom?.bodyLocked ?? null,
    consentA: a?.dom?.consent ?? null, consentB: b?.dom?.consent ?? null,
    errB: b?.error || null, errA: a?.error || null,
  };
}

export function summarize(data) {
  const rows = data.sites.map(siteRow);
  const cats = {};
  for (const r of rows) {
    const c = (cats[r.category] ||= { sites: 0, reqB: 0, reqA: 0, blockedB: 0, blockedA: 0, replacedA: 0, passedB: 0, passedA: 0, adLikeB: 0, adLikeA: 0, emptyB: 0, emptyA: 0, ratios: [], errors: 0, detectA: 0, locked: 0, consent: 0 });
    c.sites++;
    c.reqB += r.reqB || 0; c.reqA += r.reqA || 0;
    c.blockedB += r.blockedB || 0; c.blockedA += r.blockedA || 0;
    c.replacedA += r.replacedA || 0;
    c.passedB += r.passedB || 0; c.passedA += r.passedA || 0;
    c.adLikeB += r.adLikeB || 0; c.adLikeA += r.adLikeA || 0;
    c.emptyB += r.emptyB || 0; c.emptyA += r.emptyA || 0;
    if (r.textRatio != null) c.ratios.push(r.textRatio);
    if (r.errA || r.errB) c.errors++;
    if (r.detectA.length) c.detectA++;
    if (r.lockedA && !r.consentA) c.locked++;
    if (r.consentA) c.consent++;
  }
  // 通過(adban)の第三者ホストのうち広告・トラッカーらしい名前のもの。URL 例つき
  const agg = (pick, filter) => {
    const hosts = new Map();
    for (const s of data.sites) {
      for (const h of s.adban?.net?.[pick] || []) {
        if (filter && !(AD_HOST.test(h.host) || AD_HOST2.test(h.host))) continue;
        const e = hosts.get(h.host) || { host: h.host, count: 0, sites: new Set(), examples: new Set() };
        e.count += h.count; e.sites.add(s.url);
        for (const x of h.examples || []) if (e.examples.size < 2) e.examples.add(x);
        hosts.set(h.host, e);
      }
    }
    return [...hosts.values()].sort((a, b) => b.sites.size - a.sites.size || b.count - a.count).slice(0, 30)
      .map((e) => ({ host: e.host, requests: e.count, sites: e.sites.size, examples: [...e.examples] }));
  };
  const topHosts = agg('topPassedThirdParty', true);
  const topReplaced = agg('topReplaced', false);
  const sumNet = (k, mode) => data.sites.reduce((t, s) => t + (s[mode]?.net?.[k] || 0), 0);
  const totals = rows.reduce((t, r) => {
    t.reqB += r.reqB || 0; t.reqA += r.reqA || 0; t.blockedA += r.blockedA || 0; t.blockedB += r.blockedB || 0;
    t.adLikeB += r.adLikeB || 0; t.adLikeA += r.adLikeA || 0; t.emptyB += r.emptyB || 0; t.emptyA += r.emptyA || 0; return t;
  }, { reqB: 0, reqA: 0, blockedA: 0, blockedB: 0, adLikeB: 0, adLikeA: 0, emptyB: 0, emptyA: 0 });
  totals.replacedA = sumNet('replaced', 'adban');
  totals.replacedB = sumNet('replaced', 'baseline');
  totals.passedA = sumNet('passed', 'adban');
  totals.passedB = sumNet('passed', 'baseline');
  totals.passedThirdA = sumNet('passedThird', 'adban');
  totals.passedThirdB = sumNet('passedThird', 'baseline');
  totals.sites = rows.length;
  totals.errorSites = rows.filter((r) => r.errA || r.errB).length;
  totals.detectSites = rows.filter((r) => r.detectA.length).length;
  totals.consentSites = rows.filter((r) => r.consentA).length;
  totals.textRatioMedian = median(rows.map((r) => r.textRatio));
  totals.lowTextRatioSites = rows.filter((r) => r.textRatio != null && r.textRatio < 0.7).map((r) => r.url);
  return { rows, cats, topHosts, topReplaced, totals };
}

function pct(a, b) { return b ? Math.round((1 - a / b) * 100) + '%' : '-'; }

export function renderMarkdown(data) {
  const { rows, cats, topHosts, topReplaced, totals } = summarize(data);
  const m = data.meta || {};
  const L = [];
  L.push('# ADBAN 計測レポート', '');
  L.push(`- 実行: ${m.startedAt || ''} ～ ${m.finishedAt || ''}(${m.durationSec ?? '?'} 秒)`);
  L.push(`- モード: ${m.mode}、同時実行 ${m.concurrency}、待ち ${m.settle} 秒、headless: ${m.headless}`);
  if (m.adban) L.push(`- 拡張機能の読み込み: ${m.adban.method}(${m.adban.version})` +
    (m.adban.ext ? `、v${m.adban.ext.version}、登録済みスクリプト ${m.adban.ext.registeredScripts} 件、有効なルールセット: ${(m.adban.ext.enabledRulesets || []).join(', ')}` : ''));
  if (m.baseline) L.push(`- baseline: ${m.baseline.method}(${m.baseline.version})`);
  L.push('');
  L.push('## 要約', '');
  L.push(`- 計測サイト数: ${totals.sites}(失敗 ${totals.errorSites})`);
  L.push(`- 全リクエスト: baseline ${totals.reqB} -> adban ${totals.reqA}(${pct(totals.reqA, totals.reqB)} 減)`);
  L.push(`- adban の内訳: ブロック(ERR_BLOCKED_BY_CLIENT) ${totals.blockedA} / 拡張機能による差し替え ${totals.replacedA} / 通過 ${totals.passedA}(うち第三者 ${totals.passedThirdA})。baseline の通過は ${totals.passedB}(うち第三者 ${totals.passedThirdB})、ブロック ${totals.blockedB}、差し替え ${totals.replacedB}`);
  L.push(`- 画面に残った広告らしい要素(iframe + 要素): baseline ${totals.adLikeB} -> adban ${totals.adLikeA}(${pct(totals.adLikeA, totals.adLikeB)} 減)`);
  L.push(`- 中身のない広告枠(「広告」「PR」などのラベルだけが残った枠): baseline ${totals.emptyB} -> adban ${totals.emptyA}`);
  L.push(`- 本文長比(adban / baseline)の中央値: ${totals.textRatioMedian != null ? totals.textRatioMedian.toFixed(2) : '-'}。0.7 未満: ${totals.lowTextRatioSites.length} サイト(広告の中身が消えただけのこともある。画面写真と空の広告枠の数で確かめる)`);
  L.push(`- 広告ブロッカー検出メッセージが出たサイト(adban): ${totals.detectSites}。Cookie・同意画面が出たサイト(検出とは別扱い): ${totals.consentSites}`);
  L.push('');

  L.push('## カテゴリごとの合計', '');
  L.push('通過は第三者への通過リクエスト数(base / adban)。差し替えは declarativeNetRequest の redirect で resources/ の偽物に置き換えた数(adban のみ)。');
  L.push('');
  L.push('| カテゴリ | サイト | req base | req adban | ブロック | 差し替え | 通過(第三者) base / adban | 広告らしい base / adban | 空の広告枠 base / adban | 本文長比(中央値) | 検出メッセージ | 同意画面 | 失敗 |');
  L.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const [k, c] of Object.entries(cats)) {
    const mr = median(c.ratios);
    L.push(`| ${k} | ${c.sites} | ${c.reqB} | ${c.reqA} | ${c.blockedA} | ${c.replacedA} | ${c.passedB} / ${c.passedA} | ${c.adLikeB} / ${c.adLikeA} | ${c.emptyB} / ${c.emptyA} | ${mr != null ? mr.toFixed(2) : '-'} | ${c.detectA} | ${c.consent} | ${c.errors} |`);
  }
  L.push('');

  L.push('## サイトごと', '');
  L.push('req は全リクエスト数(base / adban)。ブロック・差し替えは adban の件数。通過は第三者への通過数(base / adban)。広告らしいは iframe と id/class に広告語を含む 30px 以上の要素の合計。空枠は「広告」「PR」ラベルだけが残った枠の数。本文長比は adban の innerText / baseline。');
  L.push('');
  for (const cat of Object.keys(cats)) {
    L.push(`### ${cat}`, '');
    L.push('| サイト | req | ブロック | 差し替え | 通過(第三者) | 広告らしい | 空枠 | 本文長比 | コンソールエラー | 検出 / 同意画面(adban) |');
    L.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---|');
    for (const r of rows.filter((x) => x.category === cat)) {
      const name = r.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
      const err = r.errA || r.errB;
      let det = '';
      if (r.detectA.length) det = r.detectA.map((x) => '「' + x + '」').join(' ') + (r.detectB.length ? ' (baseline でも)' : '');
      if (r.consentA) det += (det ? ' ' : '') + `[同意画面${r.lockedA ? '・スクロール固定' : ''}]`;
      else if (r.lockedA) det += (det ? ' ' : '') + '(スクロール固定)';
      L.push(`| ${esc(name)}${err ? ' !' : ''} | ${fmt(r.reqB)} / ${fmt(r.reqA)} | ${fmt(r.blockedA)} | ${fmt(r.replacedA)} | ${fmt(r.passedB)} / ${fmt(r.passedA)} | ${fmt(r.adLikeB)} / ${fmt(r.adLikeA)} | ${fmt(r.emptyB)} / ${fmt(r.emptyA)} | ${r.textRatio != null ? r.textRatio.toFixed(2) : '-'} | ${fmt(r.consoleB)} / ${fmt(r.consoleA)} | ${esc(det)} |`);
    }
    L.push('');
  }
  const errs = rows.filter((r) => r.errA || r.errB);
  if (errs.length) {
    L.push('### 計測エラー', '');
    for (const r of errs) L.push(`- ${r.url}: baseline=${r.errB || 'ok'} / adban=${r.errA || 'ok'}`);
    L.push('');
  }

  const ex = (e) => (e.examples || []).map((u) => '`' + u.replace(/^https?:\/\//, '') + '`').join('<br>');
  L.push('## 通過した広告・トラッカーらしい第三者ホスト(adban、全サイト合計)', '');
  L.push('止められず、差し替えもされず、そのまま通った通信だけ。URL 例はクエリを除いたパスまで。', '');
  if (topHosts.length) {
    L.push('| ホスト | 出たサイト数 | リクエスト数 | URL 例 |', '|---|---:|---:|---|');
    for (const h of topHosts) L.push(`| ${h.host} | ${h.sites} | ${h.requests} | ${ex(h)} |`);
  } else L.push('(なし)');
  L.push('');

  L.push('## 拡張機能が差し替えた通信(adban、全サイト合計)', '');
  L.push('元の URL のホストで数える。通過ではなく、resources/ の何もしない偽物に置き換えたもの。', '');
  if (topReplaced.length) {
    L.push('| 元のホスト | 出たサイト数 | 差し替え数 | 元の URL 例 |', '|---|---:|---:|---|');
    for (const h of topReplaced) L.push(`| ${h.host} | ${h.sites} | ${h.requests} | ${ex(h)} |`);
  } else L.push('(なし)');
  L.push('');

  const emptyList = rows.filter((r) => (r.emptyA || 0) > 0).sort((a, b) => b.emptyA - a.emptyA).slice(0, 15);
  L.push('## 空の広告枠が残ったサイト(adban、上位)', '');
  if (emptyList.length) {
    L.push('| サイト | 空枠 base / adban | 先頭 5 件(タグ.class 枠のサイズ「ラベル」) |', '|---|---:|---|');
    for (const r of emptyList) {
      const site = data.sites.find((x) => x.url === r.url);
      const lst = (site.adban?.dom?.emptyAdSlotList || []).map((e) => `${e.tag}.${(e.class || '').split(/\s+/)[0] || '-'} ${e.w}x${e.h}「${e.label}」`).join('<br>');
      L.push(`| ${esc(r.url.replace(/^https?:\/\//, ''))} | ${fmt(r.emptyB)} / ${fmt(r.emptyA)} | ${esc(lst)} |`);
    }
  } else L.push('(なし)');
  L.push('');

  L.push('## 広告ブロック検出ページ(detector)', '');
  if (data.detectors?.length) {
    L.push('| ページ | baseline | adban | 点数(adban) | adban が止めた通信 | 画面写真 |');
    L.push('|---|---|---|---|---:|---|');
    for (const d of data.detectors) {
      const b = d.baseline, a = d.adban;
      const t = (x) => (x ? (x.error ? 'エラー: ' + x.error : (x.text || '(結果なし)') + (x.done ? '' : ' (未確定)')) : '-');
      const shot = a?.shot ? path.relative(data.outDir || '.', a.shot).replace(/\\/g, '/') : '';
      L.push(`| [${esc(d.name)}](${d.url}) | ${esc(t(b))} | ${esc(t(a))} | ${esc(a?.score ?? '-')}${a?.pct != null ? ` (${a.pct}%)` : ''} | ${fmt(a?.net?.blocked)} | ${shot} |`);
    }
    L.push('');
    for (const d of data.detectors) {
      const items = d.adban?.items;
      if (!items?.length) continue;
      const bItems = new Map((d.baseline?.items || []).map((i) => [i.group + '|' + i.name, i.status]));
      const notBlocked = items.filter((i) => /not blocked|loaded/i.test(i.status));
      L.push(`### ${d.name}: 項目別(adban)`, '');
      L.push(`${items.length} 項目中、止められていないのは ${notBlocked.length} 項目。`, '');
      L.push('| グループ | 項目 | adban | baseline |', '|---|---|---|---|');
      for (const i of d.name.includes('turtlecute') ? notBlocked : items) L.push(`| ${esc(i.group)} | ${esc(i.name)}${i.detail ? '(' + esc(i.detail) + ')' : ''} | ${esc(i.status)} | ${esc(bItems.get(i.group + '|' + i.name) ?? '-')} |`);
      L.push('');
    }
  } else L.push('(未実行)');
  L.push('');

  L.push('## YouTube', '');
  const yt = data.youtube;
  if (Array.isArray(yt) && yt.length) {
    L.push('baseline で広告が 0 秒だった動画は「比較にならない」ので除外扱い(表には載せるが、判断には使わない)。', '');
    L.push('| 動画 | 比較 | baseline 広告秒 | adban 広告秒 | adban スキップ表示秒 | 倍速 b / a | 広告ブロッカー警告 b / a | 再生エラー(adban) | 動画の進み b / a(秒) |');
    L.push('|---|---|---:|---:|---:|---|---|---|---:|');
    for (const v of yt) {
      const b = v.baseline?.summary, a = v.adban?.summary;
      const warn = (x) => (x ? (x.adblockWarning ? 'あり' : 'なし') : '-');
      L.push(`| ${esc(v.label)} | ${v.comparable ? '比較可' : '比較にならない'} | ${b ? b.anyAdSeconds : '-'} | ${a ? a.anyAdSeconds : '-'} | ${a ? a.skipButtonSeconds : '-'} | ${b ? (b.fastRate ? 'あり' : 'なし') : '-'} / ${a ? (a.fastRate ? 'あり' : 'なし') : '-'} | ${warn(b)} / ${warn(a)}${a?.blockerDialogText ? ' 「' + esc(a.blockerDialogText.slice(0, 60)) + '」' : ''} | ${esc((a && (a.playErrorSeconds >= 10 || (a.maxVideoTime ?? 0) < 5) ? a.playErrorText : '') || v.adban?.error || '')} | ${b?.maxVideoTime ?? '-'} / ${a?.maxVideoTime ?? '-'} |`);
    }
    const comp = yt.filter((v) => v.comparable);
    L.push('', `比較できた動画: ${comp.length} / ${yt.length}。` + (comp.length ? `adban の広告秒合計 ${sum(comp.map((v) => v.adban?.summary?.anyAdSeconds))} 秒(baseline ${sum(comp.map((v) => v.baseline?.summary?.anyAdSeconds))} 秒)。` : ''));
  } else if (yt && (yt.baseline || yt.adban)) {
    L.push('(旧形式の結果。1 本の動画のみ)', '');
    for (const k of ['baseline', 'adban']) { const y = yt[k]; if (y?.summary) L.push(`- ${k}: 広告 ${y.summary.anyAdSeconds} 秒、動画の進み ${y.summary.maxVideoTime} 秒`); }
  } else L.push('(未実行。`--youtube` を付けると実行する)');
  L.push('');
  return L.join('\n');
}

export function writeReport(data, outDir) {
  data.outDir = outDir;
  const slim = JSON.parse(JSON.stringify(data));
  slim.summary = summarize(data);
  delete slim.summary.rows; // rows は sites から再計算できる
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(slim, null, 2));
  fs.writeFileSync(path.join(outDir, 'report.md'), renderMarkdown(data));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = path.resolve(process.argv[2] || '.');
  const data = JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'));
  delete data.summary;
  writeReport(data, dir);
  console.log('再生成しました:', path.join(dir, 'report.md'));
}
