// ADBAN: Google アナリティクス（analytics.js）と Google タグ マネージャー（gtm.js / gtag.js）の代わり。
// 送信はしないが、「送信が終わったら次のページへ移る」ような処理（hitCallback / eventCallback）は呼ぶので、リンクが止まらない。
(function () {
  'use strict';
  const noop = function () {};
  const call = (fn) => {
    try {
      fn();
    } catch {}
  };

  function Tracker() {}
  Tracker.prototype.get = noop;
  Tracker.prototype.set = noop;
  Tracker.prototype.send = noop;

  const name = window.GoogleAnalyticsObject || 'ga';
  const queue = window[name];
  const ga = function (...args) {
    const last = args[args.length - 1];
    if (last instanceof Object && typeof last.hitCallback === 'function') {
      call(last.hitCallback);
    } else if (typeof last === 'function') {
      call(() => last(ga.create()));
    } else {
      const pos = args.indexOf('hitCallback');
      if (pos !== -1 && typeof args[pos + 1] === 'function') call(args[pos + 1]);
    }
  };
  ga.create = () => new Tracker();
  ga.getByName = () => new Tracker();
  ga.getAll = () => [new Tracker()];
  ga.remove = noop;
  ga.loaded = true;
  window[name] = ga;
  if (typeof queue === 'function' && Array.isArray(queue.q)) {
    for (const entry of queue.q.splice(0)) ga(...entry);
  }

  // dataLayer の eventCallback（gtm.js）と event_callback（gtag.js）
  const dataLayer = window.dataLayer;
  if (dataLayer instanceof Object) {
    if (dataLayer.hide instanceof Object && typeof dataLayer.hide.end === 'function') {
      dataLayer.hide.end();
      dataLayer.hide.end = noop;
    }
    const callback = (item) => {
      if (!(item instanceof Object)) return;
      if (typeof item.eventCallback === 'function') {
        setTimeout(item.eventCallback, 1);
        item.eventCallback = noop;
      }
      const options = item[2];
      if (item[0] === 'event' && options instanceof Object && typeof options.event_callback === 'function') {
        setTimeout(options.event_callback, 1);
        options.event_callback = noop;
      }
    };
    if (typeof dataLayer.push === 'function') {
      dataLayer.push = new Proxy(dataLayer.push, {
        apply(target, thisArg, args) {
          callback(args[0]);
          return Reflect.apply(target, thisArg, args);
        },
      });
    }
    if (Array.isArray(dataLayer)) for (const item of dataLayer.slice()) callback(item);
  }
})();
