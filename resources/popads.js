// ADBAN: PopAds（ポップアップ広告）の代わり。
(function () {
  'use strict';
  delete window.PopAds;
  delete window.popns;
  Object.defineProperties(window, { PopAds: { value: {} }, popns: { value: {} } });
})();
