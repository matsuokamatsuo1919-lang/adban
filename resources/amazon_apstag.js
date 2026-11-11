// ADBAN: Amazon Publisher Services（apstag.js）の代わり。入札は「結果なし」としてすぐに返す。
(function () {
  'use strict';
  const noop = function () {};
  const queue = (window.apstag && window.apstag._Q) || [];
  const apstag = {
    _Q: queue,
    fetchBids(config, callback) {
      if (typeof callback === 'function') {
        try {
          callback([]);
        } catch {}
      }
    },
    init: noop,
    setDisplayBids: noop,
    targetingKeys: () => [],
  };
  window.apstag = apstag;
  const pending = queue.splice(0);
  queue.push = function (prefix, args) {
    if (prefix === 'f' && args) apstag.fetchBids(...args);
    return 0;
  };
  for (const entry of pending) {
    if (Array.isArray(entry)) queue.push(entry[0], entry[1]);
  }
})();
