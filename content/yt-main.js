// YouTube のページ側（MAIN world）で動き、プレイヤーに渡る広告の情報を取り除く。
// 広告の情報がなければ、プレイヤーは広告を流さずに本編を再生する。
// background.js が設定に合わせて登録・解除する（chrome.scripting.registerContentScripts）。
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

  const AD_KEYS = ['adPlacements', 'adSlots', 'playerAds'];

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

  // API の応答（JSON.parse と fetch の Response.json の両方の経路）
  JSON.parse = wrap(JSON.parse, {
    apply: (target, thisArg, args) => prune(Reflect.apply(target, thisArg, args)),
  });
  Response.prototype.json = wrap(Response.prototype.json, {
    apply: (target, thisArg, args) => Reflect.apply(target, thisArg, args).then(prune),
  });

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
