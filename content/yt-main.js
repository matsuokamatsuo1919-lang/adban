// YouTube のページ側（MAIN world）で動き、プレイヤーに渡る広告の情報を取り除く。
// 広告の情報がなければ、プレイヤーは広告を流さずに本編を再生する。
// background.js が設定に合わせて登録・解除する（chrome.scripting.registerContentScripts）。
//
// 取り除く場所は「実際の通信」に限る。JSON.parse や Response.prototype.json を丸ごと包んではいけない:
// YouTube のページは、広告のキー（adPlacements など）を含む偽のプレイヤー応答をその場で作り、
// JSON.parse・new Response(...).json()・data: URL の Request を fetch した結果が元のままかを確かめて、広告ブロッカーを検出している。
// 広告のキーを除くのは、ytInitialPlayerResponse と、実際の URL（response.url）が /youtubei/v1/ の fetch の応答だけにする。
// （検査の見本は YouTube 本体の taq() が作る。応答の JSON を改ざんしていないかを見る検出器は j.s_・f.i_。tools/yt-main.test.mjs に再現がある）
(() => {
  'use strict';

  // Proxy で包んだ関数を、ページから見て元の関数と同じに見せる（toString() が `function () { [native code] }` にならないように）。
  // 包んだ関数 → 元の関数 を覚えておき、Function.prototype.toString も包んで逆引きする（content/scriptlets.js の hide と同じ考え方）
  const fnToString = Function.prototype.toString;
  const weakGet = WeakMap.prototype.get;
  const weakSet = WeakMap.prototype.set;
  const originals = new WeakMap();
  const wrap = (target, handler) => {
    const proxy = new Proxy(target, handler);
    Reflect.apply(weakSet, originals, [proxy, target]);
    return proxy;
  };
  const patchedToString = new Proxy(fnToString, {
    apply: (target, thisArg, args) => Reflect.apply(target, Reflect.apply(weakGet, originals, [thisArg]) ?? thisArg, args),
  });
  Reflect.apply(weakSet, originals, [patchedToString, fnToString]);
  Function.prototype.toString = patchedToString;

  // 広告ブロッカー検出のメッセージ（auxiliaryUi.messageRenderers.bkaEnforcementMessageViewModel）は、取り除かない。
  // 応答には、サーバーが期待する値の一覧（trackingParam）が付いていて、メッセージを消すと改ざんとみなされ、
  // 「問題が発生しました」のエラー画面でブロックされる。メッセージが入っていても、ページ側の検出器
  // （Sgh）が広告ブロッカーなしと判断すれば表示されないので、大事なのは検出されないこと（上の理由で JSON.parse などを包まない）。
  const AD_KEYS = ['adPlacements', 'adSlots', 'playerAds'];
  // 応答の文字列にこれらがなければ、解析し直さずにそのまま返す
  const NEEDLE = /"(?:adPlacements|adSlots|playerAds)"/;
  // 実際の応答の URL（Response.url）。Request の url は偽装できるが、Response.url は実際の URL になる
  const API_URL = /^https:\/\/(?:[a-z0-9-]+\.)*youtube(?:-nocookie)?\.com\/youtubei\/v1\//;

  const strip = (object) => {
    if (!object || typeof object !== 'object') return;
    for (const key of AD_KEYS) if (key in object) delete object[key];
  };

  const prune = (value) => {
    try {
      if (value && typeof value === 'object') {
        strip(value);
        strip(value.playerResponse);
        if (Array.isArray(value)) {
          for (const item of value) {
            strip(item);
            strip(item?.playerResponse);
          }
        }
      }
    } catch {
      // 読めない値はそのまま返す
    }
    return value;
  };

  // fetch の応答。実際の URL が YouTube の API で、広告のキーを含むときだけ、取り除いた Response に差し替える
  const pruneResponse = (response) => {
    try {
      if (!response || !response.ok || typeof response.url !== 'string' || !API_URL.test(response.url)) return response;
      if (!/json/i.test(response.headers.get('content-type') || '')) return response;
      return response.clone().text().then(
        (text) => {
          if (!NEEDLE.test(text)) return response;
          try {
            const headers = new Headers(response.headers);
            headers.delete('content-length');
            headers.delete('content-encoding');
            const fixed = new Response(JSON.stringify(prune(JSON.parse(text))), {
              status: response.status,
              statusText: response.statusText,
              headers,
            });
            Object.defineProperty(fixed, 'url', { value: response.url });
            return fixed;
          } catch {
            return response;
          }
        },
        () => response,
      );
    } catch {
      return response;
    }
  };

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = wrap(nativeFetch, {
      apply: (target, thisArg, args) => Reflect.apply(target, thisArg, args).then(pruneResponse),
    });
  }

  // 最初の HTML に埋め込まれている var ytInitialPlayerResponse = {...}
  let initial;
  try {
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
      configurable: true,
      get: () => initial,
      set: (value) => {
        initial = prune(value);
      },
    });
  } catch {
    // すでに定義されているときは何もしない
  }
})();

// 同上（ページ側で動くので、stack の先頭になっても拡張機能のエラーとして記録されないようにする）。必ずファイルの最後に置く。
//# sourceURL=inline-1.js
