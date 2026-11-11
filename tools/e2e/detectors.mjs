// 広告ブロック検出・テストページの定義。
// expr はページ内で 1 秒おきに評価される式(最大 20 秒)。
// 返り値: { done: boolean, text: string, score?: string, pct?: number }
//   done=true になった時点で結果を確定する。pct は「止められた割合(%)」の目安。
// 開けない・結果が取れないページは外してある(d3ward.github.io/toolz/adblock.html は 2025 年にアーカイブされ、
// テスト本体が無くなっていたため除外。後継の adblock.turtlecute.org を使う)。

export const DETECTORS = [
  {
    name: 'Ad Blocker Test (turtlecute)',
    url: 'https://adblock.turtlecute.org/',
    note: 'd3ward の後継。130 個の広告・トラッカーのドメイン/要素のうち、止められた数を表示する。',
    expr: `(() => {
      const t = document.body.innerText;
      const m = t.match(/Total:\\s*(\\d+)\\s*(\\d+)\\s*blocked\\s*(\\d+)\\s*not blocked/i);
      if (!m) return { done: false, text: '' };
      const total = +m[1], blocked = +m[2];
      const key = total + '/' + blocked;
      window.__st = window.__prev === key ? (window.__st || 0) + 1 : 0; window.__prev = key;
      const same = window.__st >= 5;
      const items = [];
      for (const t of document.querySelectorAll('.test')) {
        const group = ((t.querySelector('.test_collapse') || {}).textContent || t.id || '').trim();
        for (const sv of t.querySelectorAll('svg')) {
          const row = sv.parentElement;
          const sp = row && row.querySelector('span');
          if (!sp) continue;
          const st = sv.getAttribute('stroke') || '';
          items.push({ group, name: sp.textContent.trim(), status: /green/.test(st) ? 'blocked' : /red/.test(st) ? 'not blocked' : 'unknown' });
        }
      }
      for (const tb of document.querySelectorAll('.test_block')) {
        const name = [...tb.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join('').replace(/[\\u00a0\\s]+/g, ' ').trim();
        items.push({ group: 'Cosmetic Filter / Script', name: name || tb.id, status: /green/.test(tb.className) ? 'blocked' : /red/.test(tb.className) ? 'not blocked' : 'unknown' });
      }
      return { done: same && total > 0, text: blocked + ' blocked / ' + m[3] + ' not blocked (total ' + total + ')', score: blocked + '/' + total, pct: Math.round(blocked / total * 100), items };
    })()`,
  },
  {
    name: 'FiveFilters Block Ads',
    url: 'https://blockads.fivefilters.org/',
    note: '広告ブロックを有効と判定するか。「Ad blocking enabled!」が出れば止められている。',
    expr: `(() => {
      const m = document.body.innerText.match(/Ad blocking enabled!|No ad blocking detected/i);
      return { done: !!m, text: m ? m[0] : '', pct: m ? (/enabled/i.test(m[0]) ? 100 : 0) : null };
    })()`,
  },
  {
    name: 'AdBlock Tester',
    url: 'https://adblock-tester.com/',
    note: '各項目の「test passed / failed」を数えて、passed の割合を点数とする(ページ自身の点数表示は無い)。',
    expr: `(() => {
      const lines = document.body.innerText.split('\\n');
      let pass = 0, fail = 0, unk = 0;
      for (const l of lines) {
        if (!/(Script loading|Script execution|Block visibility|File loading)/i.test(l)) continue;
        if (/passed/i.test(l)) pass++; else if (/failed/i.test(l)) fail++; else if (/unable/i.test(l)) unk++;
      }
      const n = pass + fail;
      const key = pass + ',' + fail + ',' + unk;
      window.__st = window.__prev === key ? (window.__st || 0) + 1 : 0; window.__prev = key;
      const same = window.__st >= 3;
      return { done: same && n >= 15, text: 'passed ' + pass + ' / failed ' + fail + ' / unable ' + unk, score: pass + '/' + n, pct: n ? Math.round(pass / n * 100) : null };
    })()`,
  },
  {
    name: 'Ads-blocker.com Test',
    url: 'https://ads-blocker.com/testing/',
    note: '「Run test」ボタンを 1 回押す(ページ内のローカルなテストが走るだけ)。Blocked / Not blocked の件数を読む。',
    expr: `(() => {
      if (!window.__clicked) {
        const b = [...document.querySelectorAll('button,a,input[type=button]')].find((e) => /^run test$/i.test((e.textContent || e.value || '').trim()));
        if (b) { b.click(); window.__clicked = true; }
        return { done: false, text: '' };
      }
      const t = document.body.innerText;
      const m = t.match(/Tests completed\\s*(\\d+)\\s*Blocked\\s*(\\d+)\\s*Not blocked\\s*(\\d+)\\s*Inconclusive/i);
      if (!m) return { done: false, text: '' };
      const bl = +m[1], nb = +m[2], inc = +m[3], n = bl + nb + inc;
      const items = [...document.querySelectorAll('.probe-row')].map((r) => ({
        group: 'local test',
        name: ((r.querySelector('strong') || {}).textContent || '').trim(),
        detail: ((r.querySelector('.probe-detail') || {}).textContent || '').trim(),
        status: ((r.querySelector('.badge') || {}).textContent || '').trim().toLowerCase(),
      }));
      return { done: true, text: 'Blocked ' + bl + ' / Not blocked ' + nb + ' / Inconclusive ' + inc, score: bl + '/' + n, pct: n ? Math.round(bl / n * 100) : null, items };
    })()`,
  },
  {
    name: 'Detect Adblock (detectadblock.com)',
    url: 'https://www.detectadblock.com/',
    saveScripts: true,
    note: '「You\'re blocking ads」と判定されるのは検出される側(ブロッカーが見つかった)。拡張機能が隠せていれば本来は検出されない方が望ましい。',
    expr: `(() => {
      const m = document.body.innerText.match(/You.re (blocking|allowing) ads/i);
      return { done: !!m, text: m ? m[0] : '' };
    })()`,
  },
  {
    name: 'FuckAdBlock demo (BlockAdBlock)',
    url: 'https://fuckadblock.sitexw.fr/',
    note: '餌の要素が隠されると「AdBlock is enabled」と出る。出なければ検出を回避できている。',
    expr: `(() => {
      const m = document.body.innerText.match(/AdBlock is (not )?enabled/i);
      return { done: !!m, text: m ? m[0] : '', pct: m ? (/not/i.test(m[0]) ? 100 : 0) : null };
    })()`,
  },
  {
    name: 'Can You Block It (extreme test)',
    url: 'https://canyoublockit.com/extreme-test/',
    note: '本物の広告ネットワークの広告が並ぶページ。点数は無いので、見えている iframe / 画像の数と画面写真で判断する。',
    maxWait: 14,
    expr: `(() => {
      window.__t0 = window.__t0 || Date.now();
      const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 30 && r.height > 30 && getComputedStyle(e).visibility !== 'hidden' && getComputedStyle(e).display !== 'none'; };
      const fr = [...document.querySelectorAll('iframe')].filter(vis).length;
      const im = [...document.querySelectorAll('img')].filter(vis).length;
      return { done: Date.now() - window.__t0 > 10000, text: '見えている iframe ' + fr + ' / 画像 ' + im };
    })()`,
  },
];
