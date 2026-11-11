// ADBAN: Fingerprint2 の代わり。指紋は取らず、空の結果を返す。（uBlock Origin の fingerprint2.js に合わせた）
(function () {
  'use strict';
  const hex32 = (len) => Math.floor(Math.random() * Number.MAX_SAFE_INTEGER).toString(16).slice(-len).padStart(len, '0');
  const browserId = `${hex32(8)}${hex32(8)}${hex32(8)}${hex32(8)}`;
  const fp2 = function () {};
  fp2.get = function (opts, cb) {
    if (!cb) cb = opts;
    setTimeout(() => { cb([]); }, 1);
  };
  fp2.getPromise = () => Promise.resolve([]);
  fp2.getV18 = () => browserId;
  fp2.x64hash128 = () => browserId;
  fp2.prototype = {
    get(opts, cb) {
      if (!cb) cb = opts;
      setTimeout(() => { cb(browserId, []); }, 1);
    },
  };
  self.Fingerprint2 = self.Fingerprint = fp2;
})();
