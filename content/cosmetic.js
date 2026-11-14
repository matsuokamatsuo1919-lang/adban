// すべてのページ・フレームで動き、広告を隠すための手がかりを service worker に渡す。
// 隠す CSS そのものは service worker が chrome.scripting.insertCSS で入れる（ページ側から消されにくい）。
(() => {
  'use strict';
  if (globalThis.__adbanCosmetic) return;
  globalThis.__adbanCosmetic = true;


  // ---- Prime Video の判定に使う、DOM に依存しない関数 ----
  // tools/primevideo.test.mjs が globalThis.__adbanExport 経由で取り出して試す（ページ側からは設定できない）。

  // 「広告」「Ad」のあとに、記号・空白・数字（1/2、1 of 2）・「残り」「あと」「秒」などを挟んで、時刻（m:ss）か「N秒」が続く形
  const PV_GAP = String.raw`(?:[^\p{L}\p{N}]|\d|of|残り|あと|秒|中|の|まで|約|ends?\s+in|remaining|left){0,16}?`;
  const PV_AD_TEXT_RE = new RegExp(
    String.raw`(?:^|[^a-z])(?:ads?|広告)${PV_GAP}(?:(?:\d{1,2}:)?\d{1,2}:\d{2}|\d{1,3}\s*(?:秒|s(?:ecs?|econds?)?(?![a-z])))`,
    'iu',
  );
  const PV_ADWORD_RE = /(?:^|[^a-z])(?:ads?|sponsored)(?![a-z])|広告|スポンサー/i;
  const PV_SKIPWORD_RE = /スキップ|(?:^|[^a-z])skip(?![a-z])/i;
  const PV_CLOCK_RE = /(?:^|\D)\d{1,2}:\d{2}(?!\d)/;
  // スキップボタンの文言。「イントロをスキップ」「Skip Intro」は広告ではないので通さない
  const PV_SKIP_TEXT_RE = /^(?:広告を?)?スキップ(?:する)?[\s\d秒s]*$|^skip(?:\s+ads?)?[\s\d]*s?$/i;
  const PV_MAX_REMAINING = 600; // 広告の残りとしてありえない長さ（本編の時間を読み違えたもの）は捨てる

  // "0:20" "1:02:03" "Ad 1 of 2 0:30" "15" "15秒" "あと 15 秒" から残り秒数を読む。読めなければ null
  const parseRemaining = (text) => {
    if (typeof text !== 'string') return null;
    let last = null;
    for (const m of text.matchAll(/(?:(\d+):)?(\d{1,2}):(\d{2})/g)) {
      last = (Number(m[1] || 0) * 60 + Number(m[2])) * 60 + Number(m[3]);
    }
    if (last !== null) return last;
    for (const m of text.matchAll(/(\d{1,3})\s*(?:秒|s(?:ecs?|econds?)?(?![a-z]))/gi)) last = Number(m[1]);
    if (last !== null) return last;
    const bare = /^\s*(\d{1,3})\s*$/.exec(text);
    return bare ? Number(bare[1]) : null;
  };

  const credibleRemaining = (sec) => (sec !== null && sec <= PV_MAX_REMAINING ? sec : null);

  // 「広告」と時刻が一緒に出ている文字列か（広告のタイマーの形）
  const isAdTimerText = (text) => typeof text === 'string' && PV_AD_TEXT_RE.test(text);
  const hasAdWord = (text) => typeof text === 'string' && PV_ADWORD_RE.test(text);
  const hasSkipWord = (text) => typeof text === 'string' && PV_SKIPWORD_RE.test(text);
  const hasClock = (text) => typeof text === 'string' && PV_CLOCK_RE.test(text);
  // 診断の対象にする短い文字列か（広告・スキップの語、または時刻の形）
  const isInterestingText = (text) => hasAdWord(text) || hasSkipWord(text) || hasClock(text);
  const isSkipText = (text) => typeof text === 'string' && text.length <= 24 && PV_SKIP_TEXT_RE.test(text.trim());

  // 診断に文字列を残してよいか。広告に関わる語・数字・記号だけでできている文字列だけを通す。
  // 作品名などが混じるものは null（呼び出し側で「伏せた」と記録する）
  const safeDiagText = (text) => {
    if (typeof text !== 'string') return null;
    const t = text.replace(/\s+/g, ' ').trim();
    if (!t || t.length > 40) return null;
    const rest = t
      .replace(/\d+/g, ' ')
      .replace(/\b(?:ads?|sponsored|skip|of|secs?|seconds?|min|ends?|in|remaining|left|s)\b/gi, ' ')
      .replace(/スポンサー|広告|スキップ|残り|あと|秒|分|中|の|を|は|で|する|ください|つき|なし|まで|約/g, ' ')
      .replace(/[\s:：/／\-–—·・•|｜()（）[\].,、。!！?？]/g, '');
    return rest ? null : t;
  };

  // パスの ID らしい部分（ASIN・gti・長い英数字）は作品を特定できるので * にする
  const safePath = (pathname) => {
    if (typeof pathname !== 'string') return '';
    return pathname
      .split('/')
      .map((seg) => (/^amzn1\./i.test(seg) || (/\d/.test(seg) && seg.length >= 8) || seg.length >= 24 ? '*' : seg))
      .join('/')
      .slice(0, 120);
  };

  // 通信の記録に残す対象（広告・再生に関わりそうなもの）。クエリとハッシュは捨て、ホストと（ID を伏せた）パスだけ返す
  const PV_RES_RE = /GetPlaybackResources|\.mpd|interstitial|cuepoint|playback|(?:^|[^a-z])ads?(?![a-z])/i;
  const safeResource = (url) => {
    let u;
    try { u = new URL(url); } catch { return null; }
    if (!PV_RES_RE.test(u.hostname + u.pathname)) return null;
    return { host: u.hostname, path: safePath(u.pathname) };
  };

  // 連続するフレームで同じ elements は省く（省いたフレームは「直前と同じ」）
  const deltaFrames = (frames) => {
    let prev = null;
    for (const f of frames) {
      const sig = JSON.stringify(f.elements ?? null);
      if (prev !== null && sig === prev) delete f.elements;
      prev = sig;
    }
    return frames;
  };

  const PV_DIAG_LIMIT = 20000; // 診断の 1 件あたりの上限（文字数）

  // 出来事 1 件を上限に収める。まず要素を減らし、それでも超えるなら端のフレームから捨てる
  const fitEvent = (ev, limit = PV_DIAG_LIMIT) => {
    const size = () => JSON.stringify(ev).length;
    const frames = () => [...(ev.before ?? []), ...(ev.after ?? [])];
    const steps = [
      (f) => { if (f.elements) f.elements.length = Math.min(f.elements.length, 8); },
      (f) => {
        if (f.elements) f.elements.length = Math.min(f.elements.length, 3);
        if (f.requests) f.requests.length = Math.min(f.requests.length, 3);
      },
      (f) => { delete f.requests; if (f.elements) f.elements.length = Math.min(f.elements.length, 1); },
    ];
    for (const step of steps) {
      if (size() <= limit) return ev;
      frames().forEach(step);
    }
    while (size() > limit && ((ev.before?.length ?? 0) > 0 || (ev.after?.length ?? 0) > 1)) {
      if (ev.before?.length) ev.before.shift();
      else ev.after.pop();
    }
    return ev;
  };

  if (globalThis.__adbanExport) {
    Object.assign(globalThis.__adbanExport, {
      PV_AD_TEXT_RE, parseRemaining, credibleRemaining, isAdTimerText, hasAdWord, hasSkipWord, hasClock,
      isInterestingText, isSkipText, safeDiagText, safePath, safeResource, deltaFrames, fitEvent,
    });
    return;
  }

  const send = (message) => {
    try {
      return chrome.runtime.sendMessage(message).catch(() => null);
    } catch {
      return Promise.resolve(null); // 拡張機能が再読み込みされた後など
    }
  };

  // ---- ページに出てきた class / id を集めて送る（全サイト共通の「.ad-banner」のような選択子のため）----

  const TOKEN_RE = /^-?[A-Za-z_][\w-]{0,99}$/;
  const seen = new Set();
  let classes = [];
  let ids = [];
  let timer = 0;

  const flush = () => {
    timer = 0;
    if (!classes.length && !ids.length) return;
    send({ type: 'page:tokens', classes, ids });
    classes = [];
    ids = [];
  };

  const add = (list, prefix, name) => {
    if (!TOKEN_RE.test(name) || seen.has(prefix + name)) return;
    seen.add(prefix + name);
    list.push(name);
    if (!timer) timer = setTimeout(flush, 50);
  };

  const collect = (el) => {
    if (typeof el.id === 'string' && el.id) add(ids, '#', el.id);
    if (el.classList) for (const c of el.classList) add(classes, '.', c);
  };

  const scan = (root) => {
    collect(root);
    for (const el of root.querySelectorAll('[id],[class]')) collect(el);
  };

  const watchTokens = () => {
    const observer = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === 'attributes') collect(r.target);
        else for (const node of r.addedNodes) if (node.nodeType === Node.ELEMENT_NODE) scan(node);
      }
    });
    const begin = () => {
      scan(document.documentElement);
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['id', 'class'],
      });
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
  };

  // ---- YouTube: 隠せない動画広告は、流れた瞬間にミュート・早送り・スキップする ----

  const SKIP_BUTTONS = '.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-ad-skip-button-slot button';

  const skipYouTubeAds = () => {
    let saved = null; // 広告の前の音量・再生速度
    let lastResume = 0; // 警告ダイアログで止まった再生を最後に再開しようとした時刻
    setInterval(() => {
      const player = document.querySelector('#movie_player, .html5-video-player');
      const video = player?.querySelector('video');
      if (!video) return;
      // 広告ブロッカーの警告ダイアログで止まった再生を再開する（1 秒に 1 回まで）
      if (video.paused && document.querySelector('ytd-enforcement-message-view-model') && Date.now() - lastResume >= 1000) {
        lastResume = Date.now();
        try {
          video.play()?.catch(() => {});
        } catch { /* 再生できない状態。次の確認でやり直す */ }
      }
      const ad = player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting');
      if (ad) {
        saved ??= { muted: video.muted, rate: video.playbackRate };
        video.muted = true;
        video.playbackRate = 16;
        if (Number.isFinite(video.duration) && video.currentTime < video.duration - 0.1) {
          video.currentTime = video.duration;
        }
        for (const button of document.querySelectorAll(SKIP_BUTTONS)) button.click();
      } else if (saved) {
        video.muted = saved.muted;
        video.playbackRate = saved.rate;
        saved = null;
      }
    }, 250);
  };

  // ---- Prime Video: 流れてしまった広告は、ミュートして早送りし、残り時間で止める ----
  // currentTime は動かさない（本編に食い込む・止まる報告があるため）。倍速とミュートだけで進める。
  // 広告の実画面が分からないため、検出は複数の独立した経路を重ねる。本編を倍速にしてしまうのが最悪なので、
  // 広告の印は 2 回続けて取れたときだけ信じ、印が消えたら次の確認で戻し、倍速の時間にも上限を設ける。
  // 実画面の手がかりは、診断（startPrimeDiag）が chrome.storage.local の pvDiag に残す。

  const PV_TIMERS = '[class*="atvwebplayersdk-ad-timer"], .atvwebplayersdk-adtimeindicator-text';
  const PV_SKIP_BUTTON = '.atvwebplayersdk-skip-ad-button, #atvwebplayersdk-skip-ad-button';
  const PV_PLAYER = '#dv-web-player, .webPlayerSDKContainer, .webPlayerUIContainer, .atvwebplayersdk-overlays-container, [data-testid="video-player"]';
  const PV_RATES = [16, 8, 4]; // Chrome は 16 を超えると例外を投げる。失敗したら下げる
  const PV_TICK_AD = 100;
  const PV_TICK_IDLE = 500;
  const PV_BRAKE_AT = 1; // 見積もった広告の終わりの何秒前で元の速度に戻すか
  const PV_RESUME_AT = 2.5; // 戻したあと、残りがこれより長いと分かったらまた速める
  const PV_MAX_FAST_MS = 120000; // 倍速にし続けてよい連続時間。超えたら戻し、広告の印が一度消えるまで何もしない
  const PV_BUDGET_MS = 180000; // 5 分間に倍速にしてよい合計時間（印が点滅する誤検出への備え）
  const PV_BUDGET_WINDOW_MS = 300000;
  const PV_CONFIRM = 2; // 広告の印が何回続けて取れたら広告とみなすか

  // 描画されているか（display:none・幅高さ 0 を除く）。操作バーが opacity 0 / visibility:hidden で隠れていても true
  const isRendered = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    return typeof el.checkVisibility === 'function' ? el.checkVisibility() : true;
  };

  // 目に見えているか（opacity・visibility も見る）
  const isShown = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
    }
    return true;
  };

  const playerBox = () => document.querySelector(PV_PLAYER);

  // プレーヤーの中の、広告・スキップの語か時刻を含む短い要素を集める（広告の検出と診断の両方で使う。200ms は使い回す）
  let scanCache = { t: -1e9, box: null, list: [] };
  const scanPlayer = (box) => {
    const now = performance.now();
    if (scanCache.box === box && now - scanCache.t < 200) return scanCache.list;
    const list = [];
    let n = 0;
    for (const el of box.querySelectorAll('*')) {
      if (++n > 4000 || list.length >= 60) break;
      if (el.childElementCount > 6) continue; // 大きな入れ物は見ない（中の要素を見る）
      const aria = el.getAttribute('aria-label') || '';
      const raw = el.textContent || '';
      const text = raw.length <= 120 ? raw.replace(/\s+/g, ' ').trim() : '';
      const textHit = text.length > 0 && text.length <= 40 && isInterestingText(text);
      const ariaHit = aria.length > 0 && aria.length <= 60 && (hasAdWord(aria) || hasSkipWord(aria));
      if (!textHit && !ariaHit) continue;
      // 子が 1 つで同じ文字列の入れ物は、いちばん内側だけ残す
      if (!ariaHit && el.childElementCount === 1) {
        const inner = (el.firstElementChild.textContent || '').replace(/\s+/g, ' ').trim();
        if (inner === text) continue;
      }
      list.push({ el, text: textHit ? text : '', aria: ariaHit ? aria : '' });
    }
    scanCache = { t: now, box, list };
    return list;
  };

  // 広告中なら { remaining: 秒数 or null, via: 見つけた経路 }、そうでなければ null。
  // 経路: timer（既知のクラス）/ timer-hidden（既知のクラス、操作バーが隠れている間）/
  //       short-text（短い要素の「広告 … 0:15」）/ aria（aria-label に広告の語）/ player-text（プレーヤー全体の文字）
  const detectPrimeAd = () => {
    let found = null;
    let hidden = null;
    for (const el of document.querySelectorAll(PV_TIMERS)) {
      const text = el.textContent || '';
      if (!/\d/.test(text)) continue;
      if (isShown(el)) {
        found ??= { remaining: null, via: 'timer' };
        const sec = credibleRemaining(parseRemaining(text));
        if (sec !== null) { found.remaining = sec; break; }
      } else if (!hidden && isRendered(el) && parseRemaining(text) !== null) {
        hidden = { remaining: credibleRemaining(parseRemaining(text)), via: 'timer-hidden' };
      }
    }
    if (found) return found;
    if (hidden) return hidden;
    const box = playerBox();
    if (!box) return null;
    for (const c of scanPlayer(box)) {
      if (!isRendered(c.el)) continue;
      if (c.text && isAdTimerText(c.text)) {
        return { remaining: credibleRemaining(parseRemaining(c.text)), via: 'short-text' };
      }
      if (c.aria && hasAdWord(c.aria)) {
        // 「広告」の aria-label を持つ要素の中身が時刻（または aria-label 自体に時刻）のときだけ
        const sec = parseRemaining(c.text) ?? (isAdTimerText(c.aria) ? parseRemaining(c.aria) : null);
        if (sec !== null) return { remaining: credibleRemaining(sec), via: 'aria' };
      }
    }
    // クラス名がハッシュ化された UI 向けの補助判定
    const m = PV_AD_TEXT_RE.exec((box.innerText || '').slice(0, 4000));
    return m ? { remaining: credibleRemaining(parseRemaining(m[0])), via: 'player-text' } : null;
  };

  // いちばん大きい video が本編（予告編のホバー再生などを除く）
  const mainVideo = () => {
    let best = null;
    let area = 0;
    for (const v of document.querySelectorAll('video')) {
      const r = v.getBoundingClientRect();
      if (r.width * r.height > area) { area = r.width * r.height; best = v; }
    }
    return best;
  };

  // want にする。上限を超えて例外になったら、PV_RATES のうち want より小さい値で試す
  const setRate = (video, want) => {
    if (video.playbackRate === want) return;
    for (const rate of [want, ...PV_RATES.filter((r) => r < want)]) {
      try {
        video.playbackRate = rate;
        if (video.playbackRate === rate) return;
      } catch { /* 上限を超えた。次に小さい値で試す */ }
    }
  };

  // 広告中に押してよいスキップボタン（プレーヤーの中の、見えているもの）
  const findSkipButton = () => {
    for (const button of document.querySelectorAll(PV_SKIP_BUTTON)) if (isShown(button)) return button;
    const box = playerBox();
    if (!box) return null;
    for (const el of box.querySelectorAll('button, [role="button"], [aria-label]')) {
      if (!isShown(el)) continue;
      const label = el.getAttribute('aria-label') || '';
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (isSkipText(label) || (text.length <= 24 && isSkipText(text))) return el;
    }
    return null;
  };

  // ---- Prime Video の診断: 広告の実画面（部品の名前・動画の状態）を、次に広告が流れたときのために残す ----
  // 保存するもの: video の状態、広告に関わる短い要素の名前（タグ・class・data-testid・見え方・大きさ・広告の語や時刻だけの文字）、
  //   検出の結果、広告・再生に関わりそうな通信のホストとパス（クエリなし・ID は伏せる）、ページのパス（ID は伏せる）。
  // 保存しないもの: 作品名・タイトル・document.title・プレーヤー全体の文字・アカウント情報・通信のクエリや中身。

  const startPrimeDiag = (ctx) => {
    const t0 = performance.now();
    const ring = []; // 直前のフレーム（最大 10）
    const resNew = []; // 前のフレーム以降に見えた通信
    const resKeep = []; // 直近に見えた通信（出来事・スナップショットの見出しに付ける）
    let resTotal = 0;
    let capture = null; // 取り込み中の出来事
    let prev = null;
    let prevVideo = null;
    let cooldownUntil = 0;
    let played = 0; // 再生が進んだ秒数
    let nextSnap = 60;
    let observing = false;
    let writing = Promise.resolve();

    const observe = () => {
      if (observing) return;
      observing = true;
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            const r = safeResource(e.name);
            if (!r) continue;
            resTotal++;
            const item = { ...r, type: e.initiatorType || '' };
            resNew.push(item);
            resKeep.push(item);
            if (resNew.length > 10) resNew.shift();
            if (resKeep.length > 10) resKeep.shift();
          }
        }).observe({ type: 'resource', buffered: true });
      } catch { /* 使えない環境 */ }
    };

    const save = (mutate) => {
      writing = writing.then(async () => {
        try {
          const { pvDiag } = await chrome.storage.local.get('pvDiag');
          const d = pvDiag && typeof pvDiag === 'object' ? pvDiag : {};
          d.v = 1;
          if (!Array.isArray(d.events)) d.events = [];
          if (!Array.isArray(d.snapshots)) d.snapshots = [];
          mutate(d);
          await chrome.storage.local.set({ pvDiag: d });
        } catch { /* 拡張機能が再読み込みされた・容量不足など。診断だけの話なので黙って捨てる */ }
      });
    };

    const elementEntry = (c) => {
      const el = c.el;
      const cls = typeof el.className === 'string' ? el.className : el.getAttribute('class') || '';
      const mask = (s) => safeDiagText(s) ?? '[伏せた]';
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        class: cls.slice(0, 120),
        testid: (el.getAttribute('data-testid') || '').slice(0, 60),
        aria: c.aria ? mask(c.aria) : '',
        text: c.text ? mask(c.text) : '',
        visible: typeof el.checkVisibility === 'function'
          ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : null,
        rendered: isRendered(el),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    };

    const summarize = () => {
      const video = mainVideo();
      const round1 = (n) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : String(n));
      let v = null;
      if (video) {
        const r = video.getBoundingClientRect();
        v = {
          playing: !video.paused && !video.ended,
          currentTime: round1(video.currentTime),
          duration: round1(video.duration),
          rate: video.playbackRate,
          muted: video.muted,
          readyState: video.readyState,
          w: Math.round(r.width),
          h: Math.round(r.height),
        };
      }
      const box = playerBox();
      const list = box ? scanPlayer(box) : [];
      const words = list.filter((c) => hasAdWord(c.text) || hasSkipWord(c.text) || c.aria);
      const ordered = [...words, ...list.filter((c) => !words.includes(c))].slice(0, 20);
      const found = ctx.found();
      const frame = {
        ms: Math.round(performance.now() - t0),
        video: v,
        detect: { found: !!found, remaining: found?.remaining ?? null, via: found?.via ?? null, fast: ctx.fast() },
        words: words.length,
        elements: ordered.map(elementEntry),
        requests: resNew.splice(0),
        requestTotal: resTotal,
      };
      return { frame, video };
    };

    const triggerOf = (frame, video) => {
      if (!prev) return null;
      if (frame.detect.found && !prev.detect.found) return 'ad-detected';
      if (frame.words > 0 && prev.words === 0) return 'ad-words';
      const a = prev.video;
      const b = frame.video;
      if (video && prevVideo && video !== prevVideo) return 'video-replaced';
      if (a && b) {
        if (Number.isFinite(a.duration) && Number.isFinite(b.duration) && Math.abs(a.duration - b.duration) > 1) {
          return 'video-changed';
        }
        const dt = (frame.ms - prev.ms) / 1000;
        const expected = a.playing ? a.rate * dt : 0;
        if (Math.abs(b.currentTime - a.currentTime - expected) > 3 + expected * 0.5) return 'video-jump';
      }
      return null;
    };

    const stamp = () => new Date().toISOString();

    const flush = (final) => {
      const ev = structuredClone(capture.ev);
      deltaFrames([...ev.before, ...ev.after]);
      fitEvent(ev);
      save((d) => {
        const i = d.events.findIndex((e) => e.id === ev.id);
        if (i >= 0) d.events[i] = ev;
        else d.events.unshift(ev);
        d.events = d.events.slice(0, 5); // 新しい順に最大 5 件
      });
      if (final) { capture = null; cooldownUntil = Date.now() + 15000; }
    };

    const tick = () => {
      let next = 1000;
      try {
        if (ctx.on() && document.querySelector('video')) {
          observe();
          const { frame, video } = summarize();
          const now = Date.now();
          const trig = triggerOf(frame, video);
          if (capture) {
            capture.ev.after.push(frame);
            if (trig && !capture.ev.reasons.includes(trig)) capture.ev.reasons.push(trig);
            if (capture.ev.after.length >= 20) flush(true);
            else if (capture.ev.after.length % 5 === 0) flush(false);
          } else if (trig && now >= cooldownUntil) {
            capture = {
              ev: { id: now, at: stamp(), reasons: [trig], path: safePath(location.pathname), recentRequests: resKeep.slice(), before: ring.slice(), after: [frame] },
            };
            flush(false);
          }
          // 定期のスナップショット（広告が検出できていないときの手がかり）。再生 60 秒ごと、最新 10 件
          if (prev && frame.video?.playing && prev.video?.playing && frame.video.currentTime !== prev.video.currentTime) {
            played += (frame.ms - prev.ms) / 1000;
          }
          if (played >= nextSnap) {
            nextSnap += 60;
            const snap = structuredClone({ id: now, at: stamp(), path: safePath(location.pathname), played: Math.round(played), recentRequests: resKeep.slice(), frame });
            fitEvent({ before: [], after: [snap.frame] });
            save((d) => { d.snapshots.push(snap); d.snapshots = d.snapshots.slice(-10); });
          }
          ring.push(frame);
          if (ring.length > 10) ring.shift();
          prev = frame;
          prevVideo = video;
          next = frame.detect.found ? 250 : 500;
        } else if (capture) {
          flush(true);
        }
      } catch { /* DOM が入れ替わった瞬間など。次の確認でやり直す */ }
      setTimeout(tick, next);
    };

    // タブを閉じる・隠すときは、取り込み途中の出来事を先に保存する
    const early = () => { if (capture) { try { flush(false); } catch { /* 無視 */ } } };
    addEventListener('pagehide', early);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') early(); });
    tick();
  };

  const skipPrimeVideoAds = (diagOn) => {
    let ad = null; // 広告中の状態。広告でなければ null
    let lastClick = 0;
    let lastStep = 0;
    let pending = 0; // 広告の印が連続して取れた回数
    let lockedOut = false; // 倍速の上限に達した。広告の印が一度消えるまで何もしない
    let clearSince = 0;
    let used = 0; // 直近の窓で倍速にした時間（ミリ秒）
    let usedSince = Date.now();
    const shared = { found: null };

    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.pvDiagEnabled) diagOn = changes.pvDiagEnabled.newValue === true;
      });
    } catch { /* 無視 */ }
    startPrimeDiag({ found: () => shared.found, fast: () => !!ad, on: () => diagOn });

    const tick = () => {
      let next = PV_TICK_IDLE;
      try {
        if (ad || document.querySelector('video')) next = step();
      } catch { /* DOM が入れ替わった瞬間など。次の確認でやり直す */ }
      setTimeout(tick, next);
    };

    const restore = () => {
      const { video } = ad;
      if (!ad.userUnmuted) video.muted = ad.muted;
      setRate(video, ad.normal);
      ad = null;
    };

    const step = () => {
      const now = Date.now();
      const dt = lastStep ? Math.min(now - lastStep, 1000) : 0;
      lastStep = now;
      if (now - usedSince > PV_BUDGET_WINDOW_MS) { used = 0; usedSince = now; }
      if (ad && !ad.video.isConnected) ad = null; // プレイヤーが作り直された
      const found = detectPrimeAd();
      shared.found = found;
      if (!found) {
        pending = 0;
        if (ad) restore();
        if (lockedOut) {
          clearSince ||= now;
          if (now - clearSince > 3000) lockedOut = false;
        }
        return PV_TICK_IDLE;
      }
      clearSince = 0;
      if (lockedOut) return PV_TICK_IDLE;
      const video = ad ? ad.video : mainVideo();
      if (!video) return PV_TICK_IDLE;
      // 一時停止中（ポーズ広告など）は倍速にしても意味がないので何もしない
      if (video.paused || video.ended) {
        pending = 0;
        if (ad) restore();
        return PV_TICK_IDLE;
      }
      if (!ad) {
        if (++pending < PV_CONFIRM) return PV_TICK_AD; // 1 回だけの印では動かさない
        pending = 0;
        const rate = video.playbackRate;
        ad = {
          video,
          since: now,
          muted: video.muted,
          normal: rate > 0 && rate < 4 ? rate : 1, // 広告の前の速度。異常値（前の広告の倍速が残ったものなど）なら 1
          userUnmuted: false,
          mutedByUs: false,
          end: null, // 見積もった広告の終わり（video.currentTime の値）
          shown: null, // 前回読んだ残り秒数
          braked: false,
        };
      }
      // 上限: 連続で長すぎる・直近で使いすぎなら戻して、広告の印が一度消えるまで何もしない
      used += dt;
      if (now - ad.since > PV_MAX_FAST_MS || used > PV_BUDGET_MS) {
        restore();
        lockedOut = true;
        return PV_TICK_IDLE;
      }
      // ミュートを掛け、ユーザーが自分で解除したらその区間は掛け直さない
      if (!video.muted) {
        if (ad.mutedByUs) ad.userUnmuted = true;
        else if (!ad.userUnmuted) video.muted = true;
      }
      if (!ad.userUnmuted && video.muted) ad.mutedByUs = true;
      // 広告の終わりを見積もる。表示が変わった瞬間に読むのがいちばん正確。
      // 倍速の間は表示の更新が遅れて残りが長めに出るので、見積もりは早い方を採る。
      // 表示が増えたとき（連続する次の広告）と、等倍に戻したあと（表示が遅れない）は見積もり直す
      if (found.remaining !== null && found.remaining !== ad.shown) {
        const end = video.currentTime + found.remaining;
        const fresh = ad.end === null || ad.braked || found.remaining > ad.shown;
        ad.end = fresh ? end : Math.min(ad.end, end);
        ad.shown = found.remaining;
      }
      // ブレーキ: 見積もりの終わりの PV_BRAKE_AT 秒前で元の速度に戻す（ミュートは広告の印が消えるまで続ける）。
      // 表示は 1 秒単位なので見積もりは ±1 秒ずれうる。本編に食い込まないよう早めに戻し、残りはミュートのまま等倍で流す。
      // 戻したあとは、残りがまだ PV_RESUME_AT 秒より長いと分かったときだけ、また速める
      const left = ad.end === null ? Infinity : ad.end - video.currentTime;
      if (ad.braked) {
        if (left > PV_RESUME_AT) ad.braked = false;
      } else if (left <= PV_BRAKE_AT) {
        ad.braked = true;
      }
      setRate(video, ad.braked ? ad.normal : 16);
      // 倍速中は 100ms で 1.6 秒進むので、ブレーキの時刻にちょうど確認できるよう次の確認を早める
      const untilBrake = ad.braked ? Infinity : ((left - PV_BRAKE_AT) / (video.playbackRate || 1)) * 1000;
      if (now - lastClick > 1500) {
        const button = findSkipButton();
        if (button) {
          button.click();
          lastClick = now;
        }
      }
      return Math.max(10, Math.min(PV_TICK_AD, untilBrake));
    };

    tick();
  };

  // ローカルの検証用: 127.0.0.1 / localhost のページでは、chrome.storage.local の pvTestHost が true のときだけ
  // Prime Video の処理を動かす（本番のホスト判定は background.js の PRIME_VIDEO_HOST_RE のまま。通常は何も起きない）
  const isPrimeTestPage = async () => {
    if (!/^(?:127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname)) return false;
    try {
      return (await chrome.storage.local.get('pvTestHost')).pvTestHost === true;
    } catch {
      return false;
    }
  };

  send({ type: 'page:init' }).then(async (state) => {
    if (!state?.active) return;
    if (state.tokens) watchTokens();
    if (state.youtube) skipYouTubeAds();
    if (window.top === window && (state.primevideo || (await isPrimeTestPage()))) {
      skipPrimeVideoAds(state.pvDiag === true);
    }
  });
})();
