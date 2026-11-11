// ページ側（MAIN world）で動く「スクリプレット」。広告ブロッカーを検出するスクリプトや、広告のための処理を止める小さな処理の集まり。
// 名前と引数の意味は uBlock Origin のフィルター（example.com##+js(名前, 引数…)）と同じにしてある。
//
// service worker が、スクリプレットの対象になっているサイトでだけ次の順に登録する:
//   rules/<リスト>.scriptlets.js … サイトごとに使うスクリプレットと引数の表（self.__adbanScriptlets に積む）
//   content/scriptlets.js        … このファイル。表を受け取り、今のサイトに当てはまるものを動かす
// どちらもページのスクリプトより先に動くので、ページから表を見られることはない。
(() => {
  'use strict';

  const tables = self.__adbanScriptlets;
  delete self.__adbanScriptlets;
  if (!Array.isArray(tables) || !location.hostname) return;

  // ページが後から組み込み関数を書き換えても影響を受けないよう、使うものを先に取っておく
  const reflectApply = Reflect.apply;
  const { defineProperty, getOwnPropertyDescriptor } = Reflect;
  const hasOwn = Object.hasOwn;
  const fnToString = Function.prototype.toString;
  const regexTest = RegExp.prototype.test;
  const nativeSetTimeout = self.setTimeout;
  const later = (fn, ms = 0) => reflectApply(nativeSetTimeout, self, [fn, ms]);
  const test = (re, text) => {
    re.lastIndex = 0;
    return reflectApply(regexTest, re, [text]);
  };
  const noop = function () {};

  // ---- 包んだ関数を、ページから見て元の関数と同じに見せる ----
  // Proxy で包んだ関数は、そのままだと toString() が `function () { [native code] }` になり（名前が消える）、
  // 組み込み関数でないことが分かる。包んだ関数 → 元の関数 を覚えておき、Function.prototype.toString も包んで逆引きする。
  // Function.prototype.toString.toString() も元と同じ `function toString() { [native code] }` に見える。
  const weakGet = WeakMap.prototype.get;
  const weakSet = WeakMap.prototype.set;
  const originals = new WeakMap();
  let toStringHidden = false;
  const hide = (fake, original) => {
    reflectApply(weakSet, originals, [fake, reflectApply(weakGet, originals, [original]) ?? original]);
    if (toStringHidden) return;
    toStringHidden = true;
    const patched = new Proxy(fnToString, {
      apply: (target, thisArg, args) => reflectApply(target, reflectApply(weakGet, originals, [thisArg]) ?? thisArg, args),
    });
    reflectApply(weakSet, originals, [patched, fnToString]);
    Function.prototype.toString = patched;
  };
  const wrapFn = (target, handler) => {
    const proxy = new Proxy(target, handler);
    hide(proxy, target);
    return proxy;
  };
  // プロトタイプのメソッド・ゲッターを、descriptor の属性（enumerable など）を変えずに包む（apply は Proxy の apply と同じ形）
  const hookMethod = (proto, key, apply) => {
    const desc = getOwnPropertyDescriptor(proto, key);
    if (typeof desc?.value === 'function') defineProperty(proto, key, { ...desc, value: wrapFn(desc.value, { apply }) });
  };
  const hookGetter = (proto, key, apply) => {
    const desc = getOwnPropertyDescriptor(proto, key);
    if (typeof desc?.get === 'function') defineProperty(proto, key, { ...desc, get: wrapFn(desc.get, { apply }) });
  };

  const textOf = (value) => {
    try {
      return typeof value === 'function' ? reflectApply(fnToString, value, []) : String(value);
    } catch {
      return '';
    }
  };

  // パターンの書き方: 空なら何にでも一致、/正規表現/フラグ、それ以外はその文字列を含むか（exact なら完全一致）
  const NEVER = /[^\s\S]/;
  const toRegex = (pattern = '', flags = undefined, exact = false) => {
    if (pattern === '') return /^/;
    const m = /^\/(.+)\/([dgimsuvy]*)$/.exec(pattern);
    if (m) {
      try {
        return new RegExp(m[1], m[2] || flags);
      } catch {
        return NEVER;
      }
    }
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(exact ? `^${escaped}$` : escaped, flags);
  };
  // 先頭の ! は「一致しないとき」
  const toMatcher = (pattern = '') => {
    const not = pattern.startsWith('!');
    const re = toRegex(not ? pattern.slice(1) : pattern);
    return (text) => test(re, text) !== not;
  };

  // 名前と値が交互に並ぶ追加の引数（…, stay, 1, quitAfter, 1000）
  const extraArgs = (list) => {
    const out = {};
    for (let i = 0; i + 1 < list.length; i += 2) out[list[i]] = list[i + 1];
    return out;
  };

  // document.readyState が when（loading / interactive / complete）以降になったら fn を動かす
  const READY = { loading: 1, asap: 1, interactive: 2, end: 2, 2: 2, complete: 3, idle: 3, 3: 3 };
  const runAt = (fn, when, fallback = 'interactive') => {
    const tokens = Array.isArray(when) ? when : [when];
    const level = Math.max(0, ...tokens.map((t) => READY[t] ?? 0)) || READY[fallback];
    const now = () => READY[document.readyState] ?? 3;
    if (now() >= level) {
      fn();
      return;
    }
    const listener = () => {
      if (now() < level) return;
      document.removeEventListener('readystatechange', listener, true);
      fn();
    };
    document.addEventListener('readystatechange', listener, true);
  };

  // ---- 読み書きを止める系で使う、ページのエラー表示に出ない例外 ----

  // ページに見える文字列（例外のメッセージ・Trusted Types のポリシー名）に拡張機能の名前を入れない
  const magic = `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
  let errorFilterInstalled = false;
  const installErrorFilter = () => {
    if (errorFilterInstalled) return;
    errorFilterInstalled = true;
    const isOurs = (value) => textOf(value?.message ?? value).includes(magic);
    // ページより先に登録するので、ページのエラー収集より先に握りつぶせる
    self.addEventListener(
      'error',
      (e) => {
        if (!isOurs(e.message) && !isOurs(e.error)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
      },
      true,
    );
    self.addEventListener(
      'unhandledrejection',
      (e) => {
        if (!isOurs(e.reason)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
      },
      true,
    );
  };
  const abort = () => {
    throw new ReferenceError(magic);
  };

  // 今の呼び出し元（スタック）を、uBlock Origin と同じ形の 1 行にする
  const stackText = () => {
    const docUrl = location.href.replace(/#.*$/, '');
    const lines = [];
    for (let line of String(new Error(magic).stack).split(/[\n\r]+/)) {
      if (line.includes(magic)) continue;
      line = line.trim();
      const m = /(.*?@)?(\S+)(:\d+):\d+\)?$/.exec(line);
      if (!m) continue;
      let url = m[2];
      if (url.startsWith('(')) url = url.slice(1);
      if (url === docUrl) url = 'inlineScript';
      else if (url.startsWith('<anonymous>')) url = 'injectedScript';
      let fn = m[1] !== undefined ? m[1].slice(0, -1) : line.slice(0, m.index).trim();
      if (fn.startsWith('at')) fn = fn.slice(2).trim();
      lines.push(` ${`${fn} ${url}${m[3]}:1`.trim()}`);
    }
    lines[0] = `stackDepth:${lines.length - 1}`;
    return lines.join('\t');
  };

  // a.b.c の各段にわなを仕掛ける。途中のオブジェクトがまだないときは、作られた時点で続きを仕掛ける。
  const trapChain = (owner, chain, trapLeaf) => {
    const pos = chain.indexOf('.');
    if (pos === -1) {
      trapLeaf(owner, chain);
      return;
    }
    const prop = chain.slice(0, pos);
    const rest = chain.slice(pos + 1);
    let v = owner[prop];
    if (v instanceof Object || (typeof v === 'object' && v !== null)) {
      trapChain(v, rest, trapLeaf);
      return;
    }
    const desc = getOwnPropertyDescriptor(owner, prop);
    if (desc?.set) {
      // 同じ途中の段に、別のスクリプレットが先にわなを仕掛けている。そちらを残したまま続きを仕掛ける
      if (!desc.configurable) return;
      defineProperty(owner, prop, {
        configurable: true,
        get: desc.get,
        set(a) {
          reflectApply(desc.set, this, [a]);
          if (a instanceof Object) trapChain(a, rest, trapLeaf);
        },
      });
      return;
    }
    defineProperty(owner, prop, {
      configurable: true,
      get: () => v,
      set: (a) => {
        v = a;
        if (a instanceof Object) trapChain(a, rest, trapLeaf);
      },
    });
  };

  // ---- 各スクリプレット ----

  function setConstant(chain = '', rawValue = '', ...rest) {
    if (!chain) return;
    const opts = extraArgs(rest);
    let value;
    switch (rawValue) {
      case 'undefined':
        value = undefined;
        break;
      case 'false':
        value = false;
        break;
      case 'true':
        value = true;
        break;
      case 'null':
        value = null;
        break;
      case "''":
      case '':
      case 'emptyStr':
        value = '';
        break;
      case '[]':
      case 'emptyArr':
        value = [];
        break;
      case '{}':
      case 'emptyObj':
        value = {};
        break;
      case 'noopFunc':
        value = function () {};
        break;
      case 'trueFunc':
        value = function () {
          return true;
        };
        break;
      case 'falseFunc':
        value = function () {
          return false;
        };
        break;
      case 'throwFunc':
        value = function () {
          throw '';
        };
        break;
      case 'noopCallbackFunc':
        value = function () {
          return noop;
        };
        break;
      case 'NaN':
        value = NaN;
        break;
      case 'Infinity':
        value = Infinity;
        break;
      case '-Infinity':
        value = -Infinity;
        break;
      default:
        if (!/^-?\d+$/.test(rawValue)) return;
        value = parseInt(rawValue, 10);
        if (Math.abs(value) > 0x7fff) return;
    }
    if (opts.as === 'function') {
      const v = value;
      value = () => v;
    } else if (opts.as === 'callback') {
      const v = value;
      value = () => () => v;
    } else if (opts.as === 'resolved') {
      value = Promise.resolve(value);
    } else if (opts.as === 'rejected') {
      value = Promise.reject(value);
      value.catch(noop);
    }

    // ページが違う型の値を入れたら、壊さないようにそちらを優先する
    let aborted = false;
    const mustAbort = (v) => {
      if (aborted) return true;
      aborted = v !== undefined && v !== null && value !== undefined && value !== null && typeof v !== typeof value;
      return aborted;
    };
    const trapLeaf = (owner, prop) => {
      const desc = getOwnPropertyDescriptor(owner, prop);
      if (desc instanceof Object) {
        try {
          owner[prop] = value;
        } catch {}
      }
      const prevGet = typeof desc?.get === 'function' ? desc.get : undefined;
      const prevSet = typeof desc?.set === 'function' ? desc.set : undefined;
      defineProperty(owner, prop, {
        configurable: false,
        get() {
          if (prevGet) reflectApply(prevGet, owner, []);
          return value;
        },
        set(a) {
          if (prevSet) reflectApply(prevSet, owner, [a]);
          if (mustAbort(a)) value = a;
        },
      });
    };
    runAt(() => trapChain(self, chain, trapLeaf), opts.runAt, 'loading');
  }

  function abortOnPropertyRead(chain = '') {
    if (!chain) return;
    installErrorFilter();
    trapChain(self, chain, (owner, prop) => {
      defineProperty(owner, prop, { get: abort, set: noop });
    });
  }

  function abortOnPropertyWrite(prop = '') {
    if (!prop) return;
    installErrorFilter();
    let owner = self;
    for (;;) {
      const pos = prop.indexOf('.');
      if (pos === -1) break;
      owner = owner[prop.slice(0, pos)];
      if (!(owner instanceof Object)) return;
      prop = prop.slice(pos + 1);
    }
    delete owner[prop];
    defineProperty(owner, prop, { set: abort });
  }

  // 今動いている <script>（document.currentScript）の中身が needle に一致したら、target の読み書きで止める
  function abortCurrentScript(target = '', needle = '', context = '') {
    if (!target) return;
    installErrorFilter();
    const reNeedle = toRegex(needle);
    const reContext = toRegex(context);
    const chain = target.split('.');
    let owner = self;
    let prop;
    for (;;) {
      prop = chain.shift();
      if (chain.length === 0) break;
      if (!(prop in owner)) break;
      owner = owner[prop];
      if (!(owner instanceof Object)) return;
    }
    let value;
    let desc = getOwnPropertyDescriptor(owner, prop);
    if (!(desc instanceof Object) || typeof desc.get !== 'function') {
      value = owner[prop];
      desc = undefined;
    }
    const texts = new WeakMap();
    const scriptText = (elem) => {
      let text = elem.textContent;
      if (text.trim() !== '') return text;
      if (texts.has(elem)) return texts.get(elem);
      const [, mime, content] = /^data:([^,]*),(.+)$/.exec(elem.src.trim()) ?? ['', '', ''];
      try {
        text = mime.endsWith(';base64') ? atob(content) : decodeURIComponent(content);
      } catch {}
      texts.set(elem, text);
      return text;
    };
    const validate = () => {
      const e = document.currentScript;
      if (!(e instanceof HTMLScriptElement)) return;
      if (context !== '' && !test(reContext, e.src)) return;
      if (!test(reNeedle, scriptText(e))) return;
      abort();
    };
    defineProperty(owner, prop, {
      get() {
        validate();
        return desc ? reflectApply(desc.get, owner, []) : value;
      },
      set(a) {
        validate();
        if (desc) {
          if (desc.set) reflectApply(desc.set, owner, [a]);
        } else {
          value = a;
        }
      },
    });
  }

  function abortOnStackTrace(chain = '', needle = '') {
    if (!chain || !needle) return;
    installErrorFilter();
    const matches = toMatcher(needle);
    trapChain(self, chain, (owner, prop) => {
      let v = owner[prop];
      defineProperty(owner, prop, {
        get() {
          if (matches(stackText())) abort();
          return v;
        },
        set(a) {
          if (matches(stackText())) abort();
          v = a;
        },
      });
    });
  }

  function addEventListenerDefuser(type = '', pattern = '') {
    if (!type && !pattern) return;
    const reType = toRegex(type, undefined, true);
    const rePattern = toRegex(pattern);
    const proto = EventTarget.prototype;
    proto.addEventListener = wrapFn(proto.addEventListener, {
      apply(target, thisArg, args) {
        const [t, handler] = args;
        const h = handler instanceof Object && typeof handler.handleEvent === 'function' ? handler.handleEvent : handler;
        if (test(reType, textOf(t)) && test(rePattern, textOf(h))) return undefined;
        return reflectApply(target, thisArg, args);
      },
    });
  }

  // 1000 / >1000 / <1000 / 1000-2000 / !1000 の形の範囲
  const parseRange = (text = '') => {
    let s = text;
    const not = s.startsWith('!');
    if (not) s = s.slice(1);
    let min;
    let max;
    if (s !== '') {
      const pos = s.indexOf('-');
      if (pos !== 0) min = max = parseInt(s, 10) || 0;
      if (pos !== -1) max = parseInt(s.slice(pos + 1), 10) || Number.MAX_SAFE_INTEGER;
    }
    return {
      unbound: min === undefined && max === undefined,
      test(v) {
        const n = Math.min(Math.max(Number(v) || 0, 0), 1e9);
        if (min === max) return (min === undefined || n === min) !== not;
        if (min === undefined) return n <= max !== not;
        if (max === undefined) return n >= min !== not;
        return (n >= min && n <= max) !== not;
      },
    };
  };

  // setTimeout / setInterval に渡された処理の中身が needle に一致したら、何もしない処理に差し替える
  const preventTimer = (name, needle = '', delay = '') => {
    const range = parseRange(delay);
    if (needle === '' && range.unbound) return;
    const matches = toMatcher(needle);
    self[name] = wrapFn(self[name], {
      apply(target, thisArg, args) {
        if (matches(textOf(args[0])) && range.test(args[1])) args[0] = noop;
        return reflectApply(target, thisArg, args);
      },
    });
  };

  // setTimeout / setInterval の待ち時間を縮める（待たせてから広告を出す・カウントダウンを飛ばす）
  const adjustTimer = (name, needle = '', delayArg = '', boostArg = '') => {
    const reNeedle = toRegex(needle);
    let delay = delayArg !== '*' ? parseInt(delayArg, 10) : -1;
    if (!Number.isFinite(delay)) delay = 1000;
    let boost = parseFloat(boostArg);
    boost = Number.isFinite(boost) ? Math.min(Math.max(boost, 0.001), 50) : 0.05;
    self[name] = wrapFn(self[name], {
      apply(target, thisArg, args) {
        const [fn, ms] = args;
        if ((delay === -1 || ms === delay) && test(reNeedle, textOf(fn))) args[1] = ms * boost;
        return reflectApply(target, thisArg, args);
      },
    });
  };

  // 何を読んでも呼んでも自分自身を返す「中身のないウィンドウ」
  const fakeWindow = () => {
    const proxy = new Proxy(function () {}, {
      get(_, prop) {
        if (prop === 'closed') return false;
        if (prop === Symbol.toPrimitive) return () => '';
        return proxy;
      },
      set: () => true,
      apply: () => proxy,
      construct: () => proxy,
    });
    return proxy;
  };

  function noWindowOpenIf(pattern = '', delay = '') {
    const not = pattern.startsWith('!');
    const re = toRegex(not ? pattern.slice(1) : pattern);
    const after = parseFloat(delay) || 0;
    self.open = wrapFn(self.open, {
      apply(target, thisArg, args) {
        if (test(re, args.map(textOf).join(' ')) === not) return reflectApply(target, thisArg, args);
        return after < 0 ? null : fakeWindow();
      },
    });
  }

  function nowebrtc() {
    const name = self.RTCPeerConnection ? 'RTCPeerConnection' : self.webkitRTCPeerConnection ? 'webkitRTCPeerConnection' : '';
    if (!name) return;
    const original = self[name];
    const pc = function () {};
    pc.prototype = {
      close: noop,
      createDataChannel: noop,
      createOffer: noop,
      setRemoteDescription: noop,
      toString: () => '[object RTCPeerConnection]',
    };
    // 差し替えたものも、ページから見て元の関数と同じ名前・toString に見せる
    const fake = pc.bind(self);
    defineProperty(fake, 'name', { value: original.name, configurable: true });
    hide(fake, original);
    self[name] = fake;
    if (original.prototype) {
      const originalDataChannel = original.prototype.createDataChannel;
      const fakeDataChannel = function () {
        return { close: noop, send: noop };
      }.bind(null);
      if (typeof originalDataChannel === 'function') {
        defineProperty(fakeDataChannel, 'name', { value: originalDataChannel.name, configurable: true });
        defineProperty(fakeDataChannel, 'length', { value: originalDataChannel.length, configurable: true });
        hide(fakeDataChannel, originalDataChannel);
      }
      original.prototype.createDataChannel = fakeDataChannel;
    }
  }

  // 属性・class を取り除く。behavior: asap（すぐ）/ complete（読み込み後）/ stay（その後も見張る）
  const removeAttrOrClass = (kind, rawTokens = '', rawSelector = '', behavior = '') => {
    if (!rawTokens) return;
    const tokens = rawTokens.split(/\s*\|\s*/).filter(Boolean);
    const selector = tokens
      .map((t) => (kind === 'attr' ? `${rawSelector}[${CSS.escape(t)}]` : `${rawSelector}.${CSS.escape(t)}`))
      .join(',');
    const flags = behavior.split(/\s+/);
    const clean = () => {
      try {
        for (const node of document.querySelectorAll(selector)) {
          if (kind === 'attr') for (const t of tokens) node.removeAttribute(t);
          else node.classList.remove(...tokens);
        }
      } catch {}
    };
    let timer = 0;
    const start = () => {
      clean();
      if (!flags.includes('stay')) return;
      new MutationObserver(() => {
        if (flags.includes('asap')) {
          clean();
        } else if (!timer) {
          timer = later(() => {
            timer = 0;
            clean();
          }, 17);
        }
      }).observe(document, {
        attributes: true,
        attributeFilter: kind === 'attr' ? tokens : ['class'],
        childList: true,
        subtree: true,
      });
    };
    runAt(start, flags);
  };

  // <script> などの中身を書き換える。ページの解析中に差し込まれたものを、実行される前に直す。
  let scriptPolicy;
  const toScriptText = (text) => {
    if (scriptPolicy === undefined) {
      scriptPolicy = null;
      try {
        const tt = self.trustedTypes;
        if (tt && tt.getPropertyType?.('script', 'textContent') === 'TrustedScript') {
          scriptPolicy = tt.createPolicy(magic, { createScript: (s) => s });
        }
      } catch {}
    }
    return scriptPolicy ? scriptPolicy.createScript(text) : text;
  };

  function replaceNodeText(nodeName = '', pattern = '', replacement = '', ...rest) {
    if (!nodeName) return;
    const opts = extraArgs(rest);
    const reNodeName = toRegex(nodeName, 'i', true);
    const rePattern = toRegex(pattern, 'gms');
    const reIncludes = opts.includes || opts.condition ? toRegex(opts.includes || opts.condition, 'ms') : null;
    const reExcludes = opts.excludes ? toRegex(opts.excludes, 'ms') : null;
    let sedCount = parseInt(opts.sedCount, 10) || 0;

    // false を返したら見張るのをやめる
    const handle = (node) => {
      const before = node.textContent;
      if (reIncludes && !test(reIncludes, before)) return true;
      if (reExcludes && test(reExcludes, before)) return true;
      if (!test(rePattern, before)) return true;
      rePattern.lastIndex = 0;
      const after = pattern !== '' ? before.replace(rePattern, replacement) : replacement;
      try {
        node.textContent = node.nodeName === 'SCRIPT' ? toScriptText(after) : after;
      } catch {}
      return sedCount === 0 || (sedCount -= 1) !== 0;
    };
    let observer;
    const onMutations = (records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!test(reNodeName, node.nodeName)) continue;
          if (!handle(node)) {
            observer.disconnect();
            return;
          }
        }
      }
    };
    observer = new MutationObserver(onMutations);
    observer.observe(document, { childList: true, subtree: true });
    if (document.documentElement) {
      const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!test(reNodeName, node.nodeName)) continue;
        if (!handle(node)) {
          observer.disconnect();
          return;
        }
      }
    }
    if (opts.stay) return;
    const stop = () => {
      onMutations(observer.takeRecords());
      observer.disconnect();
    };
    runAt(() => {
      const quitAfter = parseInt(opts.quitAfter, 10) || 0;
      if (quitAfter) later(stop, quitAfter);
      else stop();
    }, 'interactive');
  }

  // ---- 通信を偽の応答にすり替える ----

  // "url:/ads/ method:POST" のような条件。名前のないものは implicit（url）の条件
  const parseProps = (text = '', implicit = 'url') => {
    const needles = new Map();
    for (const needle of text.split(/\s+/)) {
      if (!needle) continue;
      const pos = needle.indexOf(':');
      let prop = pos > 0 ? needle.slice(0, pos) : '';
      let pattern = needle.slice(pos + 1);
      if (!prop || /[^$\w -]/.test(prop) || prop === 'http' || prop === 'https') {
        prop = implicit;
        pattern = needle;
      }
      needles.set(prop, toMatcher(pattern));
    }
    return needles;
  };
  const matchProps = (needles, props) => {
    for (const [prop, matches] of needles) {
      let value = props[prop];
      if (value === undefined) continue;
      if (typeof value !== 'string') {
        try {
          value = JSON.stringify(value);
        } catch {}
        if (typeof value !== 'string') continue;
      }
      if (!matches(value)) return false;
    }
    return true;
  };
  const FETCH_PROPS = ['body', 'cache', 'credentials', 'headers', 'integrity', 'keepalive', 'method', 'mode', 'redirect', 'referrer', 'referrerPolicy', 'signal'];
  const fetchProps = (resource, options) => {
    const out = { method: 'GET' };
    if (resource instanceof Request) {
      for (const p of FETCH_PROPS) out[p] = resource[p];
      out.url = resource.url;
    } else {
      out.url = String(resource);
    }
    if (options instanceof Object) for (const p of FETCH_PROPS) if (options[p] !== undefined) out[p] = options[p];
    out.method = String(out.method).toUpperCase();
    return out;
  };
  const fakeBody = (directive) => {
    if (directive === 'emptyObj') return '{}';
    if (directive === 'emptyArr') return '[]';
    if (directive === 'true') return Math.random().toString(36).slice(2, 12).padEnd(10, '0');
    return '';
  };

  function preventFetch(propsToMatch = '', responseBody = '', responseType = '') {
    const needles = parseProps(propsToMatch);
    if (!needles.size) return;
    const type = ['basic', 'cors', 'default', 'error', 'opaque'].includes(responseType) ? responseType : '';
    self.fetch = wrapFn(self.fetch, {
      apply(target, thisArg, args) {
        let props;
        try {
          props = fetchProps(args[0], args[1]);
        } catch {
          return reflectApply(target, thisArg, args);
        }
        if (!matchProps(needles, props)) return reflectApply(target, thisArg, args);
        const text = fakeBody(responseBody);
        const response = new Response(text, { status: 200, statusText: 'OK', headers: { 'Content-Length': `${text.length}` } });
        defineProperty(response, 'url', { value: props.url });
        if (type) defineProperty(response, 'type', { value: type });
        return Promise.resolve(response);
      },
    });
  }

  // XMLHttpRequest は、コンストラクターもクラスも差し替えず、プロトタイプのメソッド・ゲッターだけを包む
  // （class で継承して差し替えると、toString() がクラスのソースになり、new XMLHttpRequest().open() の引数の数の検査も変わってしまう）
  const xhrPrototype = () => self.XMLHttpRequest?.prototype;

  function preventXhr(propsToMatch = '', directive = '') {
    const needles = parseProps(propsToMatch);
    if (!needles.size) return;
    const proto = xhrPrototype();
    if (!proto) return;
    const fakes = new WeakMap();
    const done = (xhr) => {
      const f = fakes.get(xhr);
      return f?.state === 4 ? f : null;
    };
    hookMethod(proto, 'open', (target, thisArg, args) => {
      fakes.delete(thisArg);
      try {
        const props = { method: String(args[0]).toUpperCase(), url: String(args[1]) };
        if (args[2] !== false && matchProps(needles, props)) fakes.set(thisArg, { url: props.url, state: 1 });
      } catch {}
      try {
        return reflectApply(target, thisArg, args);
      } catch (e) {
        fakes.delete(thisArg);
        throw e;
      }
    });
    hookMethod(proto, 'send', (target, thisArg, args) => {
      const f = fakes.get(thisArg);
      if (!f) return reflectApply(target, thisArg, args);
      later(() => {
        f.text = fakeBody(directive);
        f.state = 4;
        thisArg.dispatchEvent(new Event('readystatechange'));
        thisArg.dispatchEvent(new ProgressEvent('load'));
        thisArg.dispatchEvent(new ProgressEvent('loadend'));
      }, 1);
    });
    hookGetter(proto, 'readyState', (target, thisArg, args) => fakes.get(thisArg)?.state ?? reflectApply(target, thisArg, args));
    hookGetter(proto, 'status', (target, thisArg, args) => (done(thisArg) ? 200 : reflectApply(target, thisArg, args)));
    hookGetter(proto, 'statusText', (target, thisArg, args) => (done(thisArg) ? 'OK' : reflectApply(target, thisArg, args)));
    hookGetter(proto, 'responseURL', (target, thisArg, args) => done(thisArg)?.url ?? reflectApply(target, thisArg, args));
    hookGetter(proto, 'responseText', (target, thisArg, args) => done(thisArg)?.text ?? reflectApply(target, thisArg, args));
    hookGetter(proto, 'response', (target, thisArg, args) => {
      const f = done(thisArg);
      if (!f) return reflectApply(target, thisArg, args);
      switch (thisArg.responseType) {
        case 'json':
          try {
            return JSON.parse(f.text);
          } catch {
            return null;
          }
        case 'arraybuffer':
          return new TextEncoder().encode(f.text).buffer;
        case 'blob':
          return new Blob([f.text]);
        case 'document':
          return null;
        default:
          return f.text;
      }
    });
    hookGetter(proto, 'responseXML', (target, thisArg, args) => (done(thisArg) ? null : reflectApply(target, thisArg, args)));
    hookMethod(proto, 'getResponseHeader', (target, thisArg, args) => (done(thisArg) ? null : reflectApply(target, thisArg, args)));
    hookMethod(proto, 'getAllResponseHeaders', (target, thisArg, args) => (done(thisArg) ? '' : reflectApply(target, thisArg, args)));
  }

  // ---- JSON から広告の設定を取り除く ----

  // a.b.c / []（配列の全要素）/ *（すべてのキー）でたどり、prune なら最後のキーを消す。見つかれば true
  const findOwner = (root, path, prune = false) => {
    let owner = root;
    let chain = path;
    for (;;) {
      if (typeof owner !== 'object' || owner === null) return false;
      const pos = chain.indexOf('.');
      if (pos === -1) {
        if (!prune) return hasOwn(owner, chain);
        let modified = false;
        if (chain === '*') {
          for (const key of Object.keys(owner)) {
            delete owner[key];
            modified = true;
          }
        } else if (hasOwn(owner, chain)) {
          delete owner[chain];
          modified = true;
        }
        return modified;
      }
      const prop = chain.slice(0, pos);
      const next = chain.slice(pos + 1);
      if ((prop === '[]' && Array.isArray(owner)) || prop === '{}' || prop === '*') {
        let found = false;
        for (const key of Object.keys(owner)) if (findOwner(owner[key], next, prune)) found = true;
        return found;
      }
      if (prop === '[-]' && Array.isArray(owner)) {
        let found = false;
        for (let i = owner.length - 1; i >= 0; i--) {
          if (!findOwner(owner[i], next)) continue;
          owner.splice(i, 1);
          found = true;
        }
        return found;
      }
      if (!hasOwn(owner, prop)) return false;
      owner = owner[prop];
      chain = next;
    }
  };
  const pruneObject = (obj, prunePaths, needlePaths) => {
    if (!needlePaths.every((p) => findOwner(obj, p))) return false;
    let pruned = false;
    for (const p of prunePaths) if (findOwner(obj, p, true)) pruned = true;
    return pruned;
  };
  const splitPaths = (text) => (text ? text.split(/ +/).filter(Boolean) : []);

  function jsonPrune(rawPrunePaths = '', rawNeedlePaths = '', stackNeedle = '') {
    const prunePaths = splitPaths(rawPrunePaths);
    if (!prunePaths.length) return;
    const needlePaths = splitPaths(rawNeedlePaths);
    const stackMatches = stackNeedle ? toMatcher(stackNeedle) : null;
    JSON.parse = wrapFn(JSON.parse, {
      apply(target, thisArg, args) {
        const obj = reflectApply(target, thisArg, args);
        if (stackMatches && !stackMatches(stackText())) return obj;
        try {
          pruneObject(obj, prunePaths, needlePaths);
        } catch {}
        return obj;
      },
    });
  }

  function jsonPruneFetchResponse(rawPrunePaths = '', rawNeedlePaths = '', ...rest) {
    const prunePaths = splitPaths(rawPrunePaths);
    if (!prunePaths.length) return;
    const needlePaths = splitPaths(rawNeedlePaths);
    const needles = parseProps(extraArgs(rest).propsToMatch ?? '');
    self.fetch = wrapFn(self.fetch, {
      apply(target, thisArg, args) {
        const pending = reflectApply(target, thisArg, args);
        try {
          if (needles.size && !matchProps(needles, fetchProps(args[0], args[1]))) return pending;
        } catch {
          return pending;
        }
        return pending.then((response) =>
          response
            .clone()
            .json()
            .then((obj) => {
              if (!pruneObject(obj, prunePaths, needlePaths)) return response;
              const out = new Response(JSON.stringify(obj), {
                status: response.status,
                statusText: response.statusText,
                headers: response.headers,
              });
              for (const p of ['ok', 'redirected', 'type', 'url']) defineProperty(out, p, { value: response[p] });
              return out;
            })
            .catch(() => response),
        );
      },
    });
  }

  // ---- XML（動画の目録・VAST）から広告を取り除く ----

  // selector は CSS セレクター、または xpath(…)。要素なら取り除き、属性ならその属性を外す。
  // selectorCheck が空でなければ、それに一致するものがある文書だけを対象にする。
  const xmlQueryAll = (xmlDoc, selector) => {
    if (!/^xpath\(.+\)$/.test(selector)) return Array.from(xmlDoc.querySelectorAll(selector));
    const result = xmlDoc.evaluate(selector.slice(6, -1), xmlDoc, null, XPathResult.UNORDERED_NODE_SNAPSHOT_TYPE, null);
    const items = [];
    for (let i = 0; i < result.snapshotLength; i++) items.push(result.snapshotItem(i));
    return items;
  };
  const xmlPruneDoc = (xmlDoc, selector, selectorCheck) => {
    try {
      if (selectorCheck !== '' && xmlDoc.querySelector(selectorCheck) === null) return xmlDoc;
      for (const item of xmlQueryAll(xmlDoc, selector)) {
        if (item.nodeType === 1) item.remove();
        else if (item.nodeType === 2) item.ownerElement.removeAttribute(item.nodeName);
      }
    } catch {}
    return xmlDoc;
  };
  // XML らしく見える文字列だけを解析し直す。失敗したら元の文字列を返す
  const xmlPruneText = (text, selector, selectorCheck) => {
    if (typeof text !== 'string' || !(/^\s*</.test(text) && />\s*$/.test(text))) return text;
    try {
      const xmlDoc = new DOMParser().parseFromString(text, 'text/xml');
      xmlPruneDoc(xmlDoc, selector, selectorCheck);
      return new XMLSerializer().serializeToString(xmlDoc);
    } catch {
      return text;
    }
  };

  function xmlPrune(selector = '', selectorCheck = '', urlPattern = '') {
    if (typeof selector !== 'string' || selector === '') return;
    const reUrl = toRegex(urlPattern);
    const prune = { doc: (d) => xmlPruneDoc(d, selector, selectorCheck), text: (t) => xmlPruneText(t, selector, selectorCheck) };

    self.fetch = wrapFn(self.fetch, {
      apply(target, thisArg, args) {
        const pending = reflectApply(target, thisArg, args);
        try {
          const arg = args[0];
          if (!test(reUrl, typeof arg === 'string' ? arg : arg instanceof Request ? arg.url : String(arg))) return pending;
        } catch {
          return pending;
        }
        return pending.then((before) =>
          before
            .clone()
            .text()
            .then((text) => {
              const after = new Response(prune.text(text), {
                status: before.status,
                statusText: before.statusText,
                headers: before.headers,
              });
              for (const p of ['ok', 'redirected', 'type', 'url']) defineProperty(after, p, { value: before[p] });
              return after;
            })
            .catch(() => before),
        );
      },
    });

    // XHR は URL の指定があるときだけ（空だと全通信が対象になってしまうため）
    if (urlPattern === '') return;
    const needles = parseProps(urlPattern, 'url');
    const tracked = new WeakMap(); // XHR ごとの書き換え済みの値（解析を繰り返さないため）
    const proto = xhrPrototype();
    if (!proto) return;
    // 完了していて対象の XHR のときだけ、その XHR の記録を返す
    const entry = (xhr) => {
      const e = tracked.get(xhr);
      return e && xhr.readyState === 4 ? e : null;
    };
    hookMethod(proto, 'open', (target, thisArg, args) => {
      tracked.delete(thisArg);
      try {
        if (matchProps(needles, { method: String(args[0]).toUpperCase(), url: String(args[1]) })) tracked.set(thisArg, {});
      } catch {}
      return reflectApply(target, thisArg, args);
    });
    hookGetter(proto, 'responseText', (target, thisArg, args) => {
      const before = reflectApply(target, thisArg, args);
      const e = entry(thisArg);
      if (!e) return before;
      if (!('text' in e)) {
        try {
          e.text = prune.text(before);
        } catch {
          e.text = before;
        }
      }
      return e.text;
    });
    hookGetter(proto, 'responseXML', (target, thisArg, args) => {
      const before = reflectApply(target, thisArg, args);
      const e = entry(thisArg);
      if (!e || !before) return before;
      if (!e.doc) {
        try {
          e.doc = prune.doc(before);
        } catch {
          e.doc = before;
        }
      }
      return e.doc;
    });
    hookGetter(proto, 'response', (target, thisArg, args) => {
      const before = reflectApply(target, thisArg, args);
      if (!entry(thisArg)) return before;
      switch (thisArg.responseType) {
        case '':
        case 'text':
          return thisArg.responseText;
        case 'document':
          return thisArg.responseXML;
        default:
          return before;
      }
    });
  }

  // ---- eval ----

  function noeval() {
    self.eval = wrapFn(self.eval, { apply: () => undefined });
  }

  function noevalIf(needle = '') {
    if (!needle) return;
    const re = toRegex(needle);
    self.eval = wrapFn(self.eval, {
      apply(target, thisArg, args) {
        if (test(re, textOf(args[0]))) return undefined;
        return reflectApply(target, thisArg, args);
      },
    });
  }

  // ---- 有名な広告ブロッカー検出ライブラリ ----

  // BlockAdBlock（難読化されたもの）を eval で動かそうとしたら止める
  function nobab() {
    const signatures = [
      ['blockadblock'],
      ['babasbm'],
      [/getItem\('babn'\)/],
      [
        'getElementById',
        'String.fromCharCode',
        'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
        'charAt',
        'DOMContentLoaded',
        'AdBlock',
        'addEventListener',
        'doScroll',
        'fromCharCode',
        '<<2|r>>4',
        'sessionStorage',
        'clientWidth',
        'localStorage',
        'Math',
        'random',
      ],
    ];
    const check = (s) =>
      signatures.some((tokens) => {
        const hits = tokens.filter((t) => (t instanceof RegExp ? s.search(t) : s.indexOf(t)) !== -1).length;
        return hits / tokens.length >= 0.8;
      });
    self.eval = wrapFn(self.eval, {
      apply(target, thisArg, args) {
        const a = args[0];
        if (typeof a !== 'string' || !check(a)) return reflectApply(target, thisArg, args);
        document.body?.style.removeProperty('visibility');
        document.getElementById('babasbmsgx')?.remove();
        return undefined;
      },
    });
    self.setTimeout = wrapFn(self.setTimeout, {
      apply(target, thisArg, args) {
        const a = args[0];
        if (typeof a === 'string' && /\.bab_elementid.$/.test(a)) return 0;
        return reflectApply(target, thisArg, args);
      },
    });
  }

  // FuckAdBlock / BlockAdBlock / SniffAdBlock を「検出しなかった」と答えるものに置き換える（resources/fuckadblock.js と同じ）
  function nofab() {
    const Fab = function () {};
    Fab.prototype.check = noop;
    Fab.prototype.clearEvent = noop;
    Fab.prototype.emitEvent = noop;
    Fab.prototype.on = function (detected, fn) {
      if (!detected) fn();
      return this;
    };
    Fab.prototype.onDetected = function () {
      return this;
    };
    Fab.prototype.onNotDetected = function (fn) {
      fn();
      return this;
    };
    Fab.prototype.setOption = noop;
    Fab.prototype.options = { set: noop, get: noop };
    const fab = new Fab();
    for (const [name, value] of [
      ['FuckAdBlock', Fab],
      ['BlockAdBlock', Fab],
      ['SniffAdBlock', Fab],
      ['fuckAdBlock', fab],
      ['blockAdBlock', fab],
      ['sniffAdBlock', fab],
    ]) {
      if (hasOwn(self, name)) self[name] = value;
      else defineProperty(self, name, { get: () => value, set: noop });
    }
  }

  function popadsDummy() {
    delete self.PopAds;
    delete self.popns;
    defineProperty(self, 'PopAds', { value: {} });
    defineProperty(self, 'popns', { value: {} });
  }

  // ---- Cookie・ストレージ（同意済み・表示済みの印など）----

  const SAFE_VALUES = new Set(
    (
      'accept reject accepted rejected notaccepted allow deny allowed denied approved disapproved checked unchecked ' +
      'dismiss dismissed enable disable enabled disabled essential nonessential forbidden forever hide hidden necessary ' +
      'required ok on off true t false f yes y no n all none functional granted done decline declined closed next ' +
      'mandatory disagree agree'
    ).split(' '),
  );
  const isSafeValue = (value, extra = []) => {
    const lower = value.toLowerCase();
    const unquoted = /^("?)(.+)\1$/.exec(lower)?.[2] ?? lower;
    if (SAFE_VALUES.has(unquoted) || extra.includes(unquoted)) return true;
    if (!/^-?\d+$/.test(unquoted)) return false;
    return Math.abs(parseInt(unquoted, 10) || 0) <= 32767;
  };
  const cookieIs = (name, value) =>
    document.cookie.split(/\s*;\s*/).some((s) => {
      const pos = s.indexOf('=');
      return pos !== -1 && s.slice(0, pos) === name && s.slice(pos + 1) === value;
    });
  const setCookie = (name = '', value = '', path = '', reload = false) => {
    if (!name || /[^!#$%&'*+\-.^_`|~0-9A-Za-z]/.test(name) || !isSafeValue(value)) return;
    if (path === '') path = '/';
    else if (path === 'none') path = '';
    if (path !== '' && path !== '/') return;
    const encoded = encodeURIComponent(value);
    if (reload && cookieIs(name, encoded)) return;
    try {
      document.cookie = `${name}=${encoded}${path ? '; path=/' : ''}`;
    } catch {}
    // 書けたら読み込み直して、サイトに cookie を見せる
    if (reload && cookieIs(name, encoded)) location.reload();
  };

  const setStorageItem = (which, key = '', value = '') => {
    if (!key) return;
    if (value === 'emptyArr') value = '[]';
    else if (value === 'emptyObj') value = '{}';
    if (!isSafeValue(value, ['', 'undefined', 'null', '{}', '[]', '""', '$remove$'])) return;
    try {
      const storage = self[`${which}Storage`];
      if (value === '$remove$') {
        const re = toRegex(key, undefined, true);
        const keys = [];
        for (let i = 0; i < storage.length; i++) if (test(re, storage.key(i))) keys.push(storage.key(i));
        for (const k of keys) storage.removeItem(k);
      } else {
        storage.setItem(key, value);
      }
    } catch {}
  };

  // ---- そのほか ----

  // <meta http-equiv="refresh"> による移動（広告ブロッカーの警告ページへ飛ばすなど）を止める
  function preventRefresh(delay = '') {
    runAt(() => {
      const meta = document.querySelector('meta[http-equiv="refresh" i][content]');
      if (!meta) return;
      const seconds = parseFloat(delay === '' ? meta.getAttribute('content') : delay) || 0;
      later(() => self.stop(), Math.max(seconds, 0) * 500);
    }, 'interactive');
  }

  // 隠した広告の枠を調べて広告ブロッカーを検出するサイトに、隠していないように見せる
  function spoofCss(selector = '', ...rest) {
    if (!selector) return;
    const camel = (s) => s.replace(/-[a-z]/g, (m) => m.charAt(1).toUpperCase());
    const values = new Map();
    for (let i = 0; i + 1 < rest.length; i += 2) {
      const prop = camel(rest[i]);
      if (!prop) break;
      values.set(prop, rest[i + 1]);
    }
    const targets = () => {
      try {
        return new WeakSet(document.querySelectorAll(selector));
      } catch {
        return new WeakSet();
      }
    };
    self.getComputedStyle = wrapFn(self.getComputedStyle, {
      apply(target, thisArg, args) {
        const style = reflectApply(target, thisArg, args);
        if (!targets().has(args[0])) return style;
        return new Proxy(style, {
          get(t, prop) {
            const v = Reflect.get(t, prop);
            if (typeof v === 'function') {
              if (prop === 'getPropertyValue') {
                return (name) => (values.has(camel(name)) ? values.get(camel(name)) : t.getPropertyValue(name));
              }
              return v.bind(t);
            }
            return typeof prop === 'string' && values.has(prop) && prop.startsWith('_') === false ? values.get(prop) : v;
          },
        });
      },
    });
    Element.prototype.getBoundingClientRect = wrapFn(Element.prototype.getBoundingClientRect, {
      apply(target, thisArg, args) {
        const rect = reflectApply(target, thisArg, args);
        if (!targets().has(thisArg)) return rect;
        const width = values.has('_rectw') ? parseFloat(values.get('_rectw')) : rect.width;
        const height = values.has('_recth') ? parseFloat(values.get('_recth')) : rect.height;
        return new DOMRect(rect.x, rect.y, width, height);
      },
    });
  }

  function windowNameDefuser() {
    if (self === self.top) self.name = '';
  }

  // 名前は lib/filters.js の SCRIPTLETS と合わせる
  // ---- リンク・属性・Cookie の掃除、XHR の応答の書き換え（リストに載っているものだけ）----

  // 追跡用の転送 URL を、本来の行き先に書き換える。source は text（リンクの文字）/ [属性名] / ?クエリーの名前
  function hrefSanitizer(selector = '', source = 'text') {
    if (!selector) return;
    if (source === '') source = 'text';
    if (!/^(?:text|\[[A-Za-z_][\w:.-]*\]|\?[^&=\s]+)$/.test(source)) return;
    const extract = (a) => {
      if (source === 'text') return a.textContent;
      if (source[0] === '[') return a.getAttribute(source.slice(1, -1));
      return new URL(a.getAttribute('href') ?? '', location.href).searchParams.get(source.slice(1));
    };
    const sanitize = (a) => {
      try {
        const value = (extract(a) ?? '').trim();
        // 属性から取るとき以外は、http(s) の絶対 URL だけを行き先とみなす（ただの文字を URL にしてしまわない）
        if (!value || (source[0] !== '[' && !/^https?:\/\//i.test(value))) return;
        const url = new URL(value, location.href);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
        if (a.getAttribute('href') !== url.href) a.setAttribute('href', url.href);
      } catch {}
    };
    const clean = () => {
      try {
        for (const node of document.querySelectorAll(selector)) if (node.localName === 'a') sanitize(node);
      } catch {}
    };
    runAt(() => {
      clean();
      let timer = 0;
      new MutationObserver(() => {
        if (!timer) {
          timer = later(() => {
            timer = 0;
            clean();
          }, 50);
        }
      }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
    }, 'interactive');
  }

  // 名前が needle に当たる Cookie を、ページを開いたときと閉じるときに消す
  function removeCookie(needle = '') {
    const re = toRegex(needle);
    const expire = () => {
      try {
        const names = document.cookie
          .split(/\s*;\s*/)
          .map((s) => s.split('=')[0])
          .filter((n) => n && test(re, n))
          .slice(0, 50);
        if (!names.length) return;
        const labels = location.hostname.split('.');
        const domains = [''];
        for (let i = 0; i < labels.length - 1; i++) {
          const h = labels.slice(i).join('.');
          domains.push(`; domain=${h}`, `; domain=.${h}`);
        }
        const paths = ['/'];
        let path = '';
        for (const seg of location.pathname.split('/').filter(Boolean).slice(0, 8)) paths.push((path += `/${seg}`));
        for (const name of names) {
          for (const domain of domains) {
            for (const p of paths) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=${p}${domain}`;
          }
        }
      } catch {}
    };
    // ページを開いたとき・組み立てが終わったとき・読み込みが終わったとき・閉じるときに消す（Cookie はページのスクリプトが後から入れることが多い）
    expire();
    runAt(expire, 'interactive');
    runAt(expire, 'complete');
    self.addEventListener('beforeunload', expire, true);
  }

  // セレクターに当たる要素の属性に、値（決まった安全な値か、[別の属性]のコピー）を入れる。遅延読み込みの src を戻すなど
  function setAttr(selector = '', attr = '', value = '') {
    if (!selector || !/^[A-Za-z_][\w:.-]*$/.test(attr) || /^on/i.test(attr)) return;
    const copy = /^\[([A-Za-z_][\w:.-]*)\]$/.exec(value)?.[1];
    if (!copy && !isSafeValue(value, [''])) return;
    const clean = () => {
      try {
        for (const node of document.querySelectorAll(selector)) {
          const v = copy ? node.getAttribute(copy) : value;
          if (v === null || /^\s*(?:javascript:|data:text\/html)/i.test(v)) continue;
          if (node.getAttribute(attr) !== v) node.setAttribute(attr, v);
        }
      } catch {}
    };
    runAt(() => {
      clean();
      let timer = 0;
      new MutationObserver(() => {
        if (!timer) {
          timer = later(() => {
            timer = 0;
            clean();
          }, 50);
        }
      }).observe(document, { childList: true, subtree: true });
    }, 'interactive');
  }

  // target 付きのリンク（新しいタブで開く）のクリックを止める
  function disableNewtabLinks() {
    document.addEventListener(
      'click',
      (ev) => {
        for (let t = ev.target; t; t = t.parentNode) {
          if (t.localName === 'a' && t.hasAttribute('target')) {
            ev.stopPropagation();
            ev.preventDefault();
            return;
          }
        }
      },
      { capture: true },
    );
  }

  // requestAnimationFrame に渡された処理の中身が needle に一致したら、何もしない処理に差し替える
  function preventRaf(needle = '') {
    if (needle === '') return;
    const matches = toMatcher(needle);
    self.requestAnimationFrame = wrapFn(self.requestAnimationFrame, {
      apply(target, thisArg, args) {
        if (matches(textOf(args[0]))) args[0] = noop;
        return reflectApply(target, thisArg, args);
      },
    });
  }

  // XHR の応答（JSON）から広告の設定を取り除く。条件は propsToMatch（url:・method:）
  function jsonPruneXhrResponse(rawPrunePaths = '', rawNeedlePaths = '', ...rest) {
    const prunePaths = splitPaths(rawPrunePaths);
    if (!prunePaths.length) return;
    const needlePaths = splitPaths(rawNeedlePaths);
    const needles = parseProps(extraArgs(rest).propsToMatch ?? '');
    const states = new WeakMap();
    const proto = xhrPrototype();
    if (!proto) return;
    hookMethod(proto, 'open', (target, thisArg, args) => {
      states.delete(thisArg);
      try {
        if (!needles.size || matchProps(needles, { method: String(args[0]).toUpperCase(), url: String(args[1]) })) states.set(thisArg, {});
      } catch {}
      return reflectApply(target, thisArg, args);
    });
    hookGetter(proto, 'responseText', (target, thisArg, args) => {
      const raw = reflectApply(target, thisArg, args);
      const s = states.get(thisArg);
      if (!s || thisArg.readyState !== 4) return raw;
      if (s.text === undefined) {
        s.text = raw;
        try {
          const obj = JSON.parse(raw);
          if (pruneObject(obj, prunePaths, needlePaths)) s.text = JSON.stringify(obj);
        } catch {}
      }
      return s.text;
    });
    hookGetter(proto, 'response', (target, thisArg, args) => {
      const s = states.get(thisArg);
      if (!s || thisArg.readyState !== 4) return reflectApply(target, thisArg, args);
      const type = thisArg.responseType;
      if (type === '' || type === 'text') return thisArg.responseText;
      const value = reflectApply(target, thisArg, args);
      if (type === 'json' && !s.done) {
        s.done = true;
        try {
          pruneObject(value, prunePaths, needlePaths);
        } catch {}
      }
      return value;
    });
  }

  const scriptlets = {
    'set-constant': setConstant,
    'abort-on-property-read': abortOnPropertyRead,
    'abort-on-property-write': abortOnPropertyWrite,
    'abort-current-script': abortCurrentScript,
    'abort-on-stack-trace': abortOnStackTrace,
    'addEventListener-defuser': addEventListenerDefuser,
    'prevent-setTimeout': (...a) => preventTimer('setTimeout', ...a),
    'prevent-setInterval': (...a) => preventTimer('setInterval', ...a),
    'adjust-setTimeout': (...a) => adjustTimer('setTimeout', ...a),
    'adjust-setInterval': (...a) => adjustTimer('setInterval', ...a),
    'no-window-open-if': noWindowOpenIf,
    nowebrtc: nowebrtc,
    'remove-attr': (...a) => removeAttrOrClass('attr', ...a),
    'remove-class': (...a) => removeAttrOrClass('class', ...a),
    'remove-node-text': (nodeName, condition = '', ...rest) =>
      condition && replaceNodeText(nodeName, '', '', 'includes', condition, ...rest),
    'replace-node-text': replaceNodeText,
    'prevent-fetch': preventFetch,
    'prevent-xhr': preventXhr,
    noeval: noeval,
    'noeval-if': noevalIf,
    'json-prune': jsonPrune,
    'json-prune-fetch-response': jsonPruneFetchResponse,
    'xml-prune': xmlPrune,
    nobab: nobab,
    nofab: nofab,
    'popads-dummy': popadsDummy,
    'set-cookie': (name, value, path) => setCookie(name, value, path),
    'set-cookie-reload': (name, value, path) => setCookie(name, value, path, true),
    'set-local-storage-item': (key, value) => setStorageItem('local', key, value),
    'set-session-storage-item': (key, value) => setStorageItem('session', key, value),
    'prevent-refresh': preventRefresh,
    'spoof-css': spoofCss,
    'window.name-defuser': windowNameDefuser,
    'href-sanitizer': hrefSanitizer,
    'remove-cookie': removeCookie,
    'set-attr': setAttr,
    'disable-newtab-links': disableNewtabLinks,
    'prevent-requestAnimationFrame': preventRaf,
    'json-prune-xhr-response': jsonPruneXhrResponse,
  };

  // ---- 今のサイトに当てはまるものを動かす ----

  const chain = [];
  for (let h = location.hostname; h; ) {
    chain.push(h);
    const dot = h.indexOf('.');
    if (dot < 0) break;
    h = h.slice(dot + 1);
  }
  // example.*（エンティティ）の指定: 公開サフィックスの手前を鍵にする（lib/hosts.js の entityChain と同じ判定）
  {
    const labels = location.hostname.split('.');
    const n = labels.length;
    if (n >= 2 && !location.hostname.includes(':') && /^(?:[a-z]{2,24}|xn--[a-z0-9-]+)$/.test(labels[n - 1])) {
      const second = new Set(['co', 'com', 'ne', 'or', 'ac', 'go', 'ed', 'gov', 'edu', 'org', 'net', 'gr', 'lg', 'mil', 'nom', 'sch']);
      const rest = labels.slice(0, n - (n >= 3 && labels[n - 1].length === 2 && second.has(labels[n - 2]) ? 2 : 1));
      for (let i = 0; i < rest.length; i++) chain.push(`${rest.slice(i).join('.')}.*`);
    }
  }
  const lookup = (map, host) => (map && hasOwn(map, host) ? map[host] : []);

  const removed = new Set();
  for (const t of tables) {
    for (const h of chain) {
      for (const i of lookup(t.remove, h)) {
        if (i < 0) return; // このサイトではすべて止める
        removed.add(JSON.stringify(t.entries[i]));
      }
    }
  }
  const run = new Map();
  for (const t of tables) {
    for (const h of chain) {
      for (const i of lookup(t.add, h)) {
        const key = JSON.stringify(t.entries[i]);
        if (!removed.has(key)) run.set(key, t.entries[i]);
      }
    }
  }
  for (const [name, ...args] of run.values()) {
    if (!hasOwn(scriptlets, name)) continue;
    try {
      scriptlets[name](...args);
    } catch {
      // 1 つが失敗しても、ほかのものは動かす
    }
  }
})();

// ページが呼んだ fetch の失敗などで、この拡張機能のファイルが stack の先頭に来ても、Chrome が「拡張機能のエラー」として記録しないようにする。
// （Chrome は stack の先頭のフレームの URL が chrome-extension:// のときだけ、その拡張機能のエラーにする。sourceURL があるとフレームの名前はこちらになる）
// この行は必ずファイルの最後に置くこと（tools/main-world-source-url.test.mjs が確かめる）。
//# sourceURL=inline-0.js
