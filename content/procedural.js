// 手続き型の要素隠し（:has-text()・:upward()・:xpath() など、ブラウザーの CSS では書けない拡張 CSS）を評価する。
// 選択子の解析は変換のときに済んでいる（lib/filters.js の parseProcedural）。ここは service worker から受け取った
// 「基点の CSS + 演算子の列」のプログラムを DOM に当てるだけ。形の定義は lib/filters.js の「手続き型の要素隠し」の節を見る。
//
// 軽さのために:
//   ・そのサイトに効くプログラムがなければ何もしない（MutationObserver も作らない）
//   ・DOM の変化は MutationObserver で集め、変わった要素とその祖先だけを「再評価が必要」と印を付ける
//   ・1 回の処理は BUDGET_MS で区切り、超えたら次のフレームに回す
//   ・正規表現にかけるテキストは MAX_TEXT 文字まで
//   ・1 つのプログラムの失敗（不正な選択子など）はほかに影響しない
(() => {
  'use strict';
  if (globalThis.__adbanProcedural) return;
  // 処理の回数と時間（計測用。isolated world の中にあるので、ページからは見えない）
  const stats = { passes: 0, slices: 0, spentMs: 0, maxSliceMs: 0, programs: 0 };
  globalThis.__adbanProcedural = stats;

  const BUDGET_MS = 8; // 1 回の処理に使ってよい時間
  const MIN_DELAY_MS = 50; // 変化を受けてから調べ直すまでの最短の間隔
  const MAX_DELAY_MS = 1000;
  const MAX_TEXT = 10000; // テキストの照合に使う長さの上限（ReDoS・巨大な要素への対策）
  const MAX_RESULTS = 500; // 1 つの演算子が返す要素の数の上限
  // 兄弟セレクターの評価のために一時的に付ける目印の属性。名前はページごとに乱数で決める（拡張機能の名前を入れない）
  const MARK = `data-${Math.random().toString(36).slice(2, 10).padEnd(8, 'x')}`;
  const EMPTY = Object.freeze([]);

  const send = (message) => {
    try {
      return chrome.runtime.sendMessage(message).catch(() => null);
    } catch {
      return Promise.resolve(null); // 拡張機能が再読み込みされた後など
    }
  };

  // ---- パターン（['t', 文字] / ['e', 文字] / ['r', 正規表現, フラグ]）→ 判定する関数 ----

  const compilePattern = (p) => {
    if (p[0] === 't') return (text) => text.includes(p[1]);
    if (p[0] === 'e') {
      const re = new RegExp(`^${p[1].replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 's');
      return (text) => re.test(text);
    }
    const re = new RegExp(p[1], p[2]);
    return (text) => re.test(text);
  };

  const textOf = (el) => {
    const text = el.textContent;
    return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
  };

  // ---- 演算子 → 「要素 1 つを受け取り、次の要素の配列を返す」関数 ----

  const scoped = (el, css) => {
    const out = [];
    for (const e of el.querySelectorAll(`:scope ${css}`)) {
      out.push(e);
      if (out.length >= MAX_RESULTS) break;
    }
    return out;
  };

  const compileStep = (step) => {
    const [name] = step;
    switch (name) {
      case 'text': {
        const test = compilePattern(step[1]);
        return (el) => (test(textOf(el)) ? [el] : EMPTY);
      }
      case 'has':
      case 'nothas': {
        const inner = compileInner(step[1]);
        const want = name === 'has';
        return (el) => (hasInner(el, inner) === want ? [el] : EMPTY);
      }
      case 'not': {
        const inner = compileInner(step[1]);
        return (el) => (matchesInner(el, inner) ? EMPTY : [el]);
      }
      case 'up': {
        const n = step[1];
        if (typeof n === 'number') {
          return (el) => {
            let e = el;
            for (let i = 0; i < n && e; i++) e = e.parentElement;
            return e ? [e] : EMPTY;
          };
        }
        return (el) => {
          const e = el.parentElement?.closest(n);
          return e ? [e] : EMPTY;
        };
      }
      case 'xpath': {
        const expr = step[1];
        return (el) => {
          const snap = document.evaluate(expr, el, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
          const out = [];
          for (let i = 0; i < snap.snapshotLength && out.length < MAX_RESULTS; i++) {
            const n = snap.snapshotItem(i);
            if (n.nodeType === 1) out.push(n);
          }
          return out;
        };
      }
      case 'mcss': {
        const [, prop, pattern, pseudo] = step;
        const test = compilePattern(pattern);
        return (el) => {
          const value = getComputedStyle(el, pseudo || null).getPropertyValue(prop);
          // content は "広告" のように引用符付きで返るので、外した形でも照合する
          if (test(value)) return [el];
          return prop === 'content' && /^(["']).*\1$/s.test(value) && test(value.slice(1, -1)) ? [el] : EMPTY;
        };
      }
      case 'mattr': {
        const testName = compilePattern(step[1]);
        const testValue = step[2] && compilePattern(step[2]);
        return (el) => {
          for (const a of el.attributes) if (testName(a.name) && (!testValue || testValue(a.value))) return [el];
          return EMPTY;
        };
      }
      case 'mmedia': {
        const mql = matchMedia(step[1]);
        return (el) => (mql.matches ? [el] : EMPTY);
      }
      case 'minlen': {
        const n = step[1];
        return (el) => (el.textContent.length >= n ? [el] : EMPTY);
      }
      case 'others':
        return (el) => [el]; // 実際の処理は applyOthers
      case 'sel':
        return (el) => scoped(el, step[1]);
      case 'sib':
        // 兄弟は el.querySelectorAll では探せないので、目印を付けて文書全体から探す
        return (el) => {
          el.setAttribute(MARK, '');
          try {
            return Array.from(document.querySelectorAll(`[${MARK}] ${step[1]}`)).slice(0, MAX_RESULTS);
          } finally {
            el.removeAttribute(MARK);
          }
        };
      case 'f':
        return (el) => (el.matches(step[1]) ? [el] : EMPTY);
    }
    throw new Error(`未対応の演算子: ${name}`);
  };

  const compileInner = (prog) => ({ c: prog.c, steps: prog.s.map(compileStep) });

  const runSteps = (el, steps) => {
    let cur = [el];
    for (const step of steps) {
      const next = [];
      for (const e of cur) for (const r of step(e)) next.push(r);
      if (!next.length) return EMPTY;
      cur = next;
    }
    return cur;
  };

  // el の子孫に、inner に当てはまるものがあるか（:has）
  const hasInner = (el, inner) => {
    const candidates = inner.c ? el.querySelectorAll(`:scope ${inner.c}`) : el.querySelectorAll('*');
    for (const d of candidates) if (runSteps(d, inner.steps).length) return true;
    return false;
  };

  // el 自身が inner に当てはまるか（:not の中）
  const matchesInner = (el, inner) => (!inner.c || el.matches(inner.c)) && runSteps(el, inner.steps).length > 0;

  // ---- プログラム ----

  const isVolatileStep = (step) => {
    const name = step[0];
    if (name === 'xpath' || name === 'sib' || name === 'mmedia' || name === 'mcss' || name === 'up') return true;
    if (name === 'has' || name === 'nothas' || name === 'not') return step[1].s.some(isVolatileStep);
    return false;
  };

  const usesAttributes = (step) => {
    if (step[0] === 'mattr' || step[0] === 'mcss') return true;
    if (step[0] === 'has' || step[0] === 'nothas' || step[0] === 'not') return step[1].s.some(usesAttributes);
    return false;
  };

  const parseDecls = (text) =>
    text
      .split(';')
      .map((d) => {
        const i = d.indexOf(':');
        if (i <= 0) return null;
        const m = /^(.*?)\s*!\s*important\s*$/i.exec(d.slice(i + 1).trim());
        return { name: d.slice(0, i).trim(), value: m ? m[1] : d.slice(i + 1).trim(), priority: m ? 'important' : '' };
      })
      .filter(Boolean);

  const compile = (prog) => ({
    c: prog.c,
    steps: prog.s.map(compileStep),
    others: prog.s.length === 1 && prog.s[0][0] === 'others',
    action: prog.a ?? null,
    decls: prog.a?.[0] === 'style' ? parseDecls(prog.a[1]) : null,
    path: prog.p ? prog.p.map(compilePattern) : null,
    volatile: prog.s.some(isVolatileStep),
    allAttributes: !!prog.w || prog.s.some(usesAttributes),
    checked: new WeakMap(), // 要素 → 最後に調べたときの時刻（clock）
    broken: false,
  });

  // ---- 変化の追跡 ----

  const dirty = new WeakMap(); // 要素 → 最後に変化した時刻（clock）。その要素の中・属性が変わると、祖先も含めて印が付く
  let clock = 1;
  let programs = [];

  const touch = (node) => {
    let el = node.nodeType === 1 ? node : node.parentElement;
    while (el && dirty.get(el) !== clock) {
      dirty.set(el, clock);
      el = el.parentElement;
    }
  };

  // 関係のありそうな変化があれば true
  const noteRecords = (records) => {
    if (!records.length) return false;
    clock++;
    let relevant = false;
    for (const r of records) {
      if (r.type === 'childList') {
        for (const n of r.addedNodes) if (n.nodeType === 1 && n.getAttribute?.(MARK) === null) relevant = true;
        if (r.removedNodes.length) relevant = true;
      } else if (r.target.nodeType === 1 && r.attributeName === MARK) {
        continue; // 自分で付けた目印
      } else {
        relevant = true;
      }
      touch(r.target);
    }
    return relevant;
  };

  // ---- 適用 ----

  const SKIP_OTHERS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE', 'TITLE', 'BASE', 'HEAD']);

  const protectedElement = (el) => el === document.documentElement || el === document.body || el === document.head;

  const setStyle = (el, name, value, priority) => {
    const style = el.style;
    if (!style) return;
    if (style.getPropertyValue(name) !== value || style.getPropertyPriority(name) !== priority) {
      style.setProperty(name, value, priority);
    }
  };

  const apply = (p, el) => {
    const a = p.action;
    if (!a) {
      if (!protectedElement(el)) setStyle(el, 'display', 'none', 'important');
    } else if (a[0] === 'rm') {
      if (!protectedElement(el)) el.remove();
    } else if (a[0] === 'style') {
      for (const d of p.decls) setStyle(el, d.name, d.value, d.priority);
    } else if (a[0] === 'ra') {
      if (el.hasAttribute(a[1])) el.removeAttribute(a[1]);
    } else if (a[0] === 'rc') {
      if (el.classList.contains(a[1])) el.classList.remove(a[1]);
    }
  };

  // :others() … 基点の CSS（カンマ区切りの全体）に当たるものと、その祖先・子孫を残し、body の中のほかをすべて隠す
  const applyOthers = (p) => {
    if (!document.body) return;
    const keep = new Set(); // 子孫もそのまま残す
    const ancestors = new Set(); // 中を調べる
    for (const el of document.querySelectorAll(p.c)) {
      keep.add(el);
      for (let a = el.parentElement; a && !ancestors.has(a); a = a.parentElement) ancestors.add(a);
    }
    if (!keep.size) return; // 何も見つからないときに、ページ全体を隠してしまわない
    const walk = (parent) => {
      for (const child of parent.children) {
        if (keep.has(child) || SKIP_OTHERS.has(child.tagName)) continue;
        if (ancestors.has(child)) walk(child);
        else setStyle(child, 'display', 'none', 'important');
      }
    };
    walk(document.body);
  };

  const pathOk = (p) => {
    if (!p.path) return true;
    const path = location.pathname + location.search;
    return p.path.every((test) => test(path));
  };

  const evaluate = (p, el) => {
    const was = p.checked.get(el);
    if (was !== undefined && !p.volatile && !(dirty.get(el) > was)) return;
    p.checked.set(el, clock);
    for (const target of runSteps(el, p.steps)) apply(p, target);
  };

  // ---- 処理の進め方 ----

  let observer = null;
  let pass = null; // 実行中の処理 { tasks, index, started }
  let rerun = false; // 処理の途中で変化があったので、終わったらもう一度行う
  let timer = 0;
  let delay = MIN_DELAY_MS;

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

  const schedule = (wait = delay) => {
    if (pass) {
      rerun = true;
      return;
    }
    if (timer) return;
    timer = setTimeout(() => {
      timer = 0;
      startPass();
    }, wait);
  };

  const startPass = () => {
    stats.passes++;
    pass = {
      tasks: programs.filter((p) => !p.broken && pathOk(p)).map((p) => ({ p, list: null, i: 0 })),
      index: 0,
      started: performance.now(),
      spent: 0,
    };
    runSlice();
  };

  const runSlice = () => {
    const begin = performance.now();
    const deadline = begin + BUDGET_MS;
    if (observer) noteRecords(observer.takeRecords());
    let finished = true;
    for (; pass.index < pass.tasks.length; pass.index++) {
      const task = pass.tasks[pass.index];
      const p = task.p;
      try {
        if (p.others) {
          applyOthers(p);
          continue;
        }
        task.list ??= document.querySelectorAll(p.c);
        while (task.i < task.list.length) {
          const el = task.list[task.i++];
          try {
            evaluate(p, el);
          } catch (e) {
            // 不正な選択子は、そのプログラムだけ止める。要素 1 つの失敗（外れた要素への XPath など）は、その要素だけ飛ばす
            if (e instanceof DOMException && e.name === 'SyntaxError') {
              p.broken = true;
              break;
            }
          }
          if (performance.now() > deadline) {
            finished = false;
            break;
          }
        }
        if (!finished) break;
      } catch {
        // 基点の CSS が不正（querySelectorAll の失敗）。そのプログラムは止める
        p.broken = true;
      }
    }
    if (observer) observer.takeRecords(); // ここまでの変化は自分が起こしたもの
    const took = performance.now() - begin;
    pass.spent += took;
    stats.slices++;
    stats.spentMs += took;
    if (took > stats.maxSliceMs) stats.maxSliceMs = took;
    if (!finished) {
      nextFrame(runSlice);
      return;
    }
    // 重かった処理のあとは、間隔を空ける
    delay = Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, pass.spent * 4));
    pass = null;
    if (rerun) {
      rerun = false;
      schedule();
    }
  };

  const start = () => {
    const allAttributes = programs.some((p) => p.allAttributes);
    observer = new MutationObserver((records) => {
      if (noteRecords(records)) schedule();
    });
    const begin = () => {
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        ...(allAttributes ? {} : { attributeFilter: ['class', 'id', 'style', 'hidden', 'href', 'src'] }),
      });
      schedule(0);
    };
    if (document.documentElement) {
      begin();
    } else {
      new MutationObserver((_, o) => {
        if (!document.documentElement) return;
        o.disconnect();
        begin();
      }).observe(document, { childList: true });
    }
    addEventListener('DOMContentLoaded', () => schedule(0), { once: true });
    addEventListener('load', () => schedule(0), { once: true });
  };

  send({ type: 'page:procedural' }).then((state) => {
    const list = state?.programs;
    if (!Array.isArray(list) || !list.length) return; // 手続き型の選択子がないサイトでは、ここで終わり
    for (const prog of list) {
      try {
        programs.push(compile(prog));
      } catch {
        // 解釈できないプログラムは使わない
      }
    }
    stats.programs = programs.length;
    if (programs.length) start();
  });
})();
