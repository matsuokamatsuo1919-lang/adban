// ADBAN: chartbeat.js の代わり。計測は何もせず、読み込み中に画面を隠すスタイルだけ取り除く。
(function () {
  'use strict';
  const noopfn = function () {};
  window.pSUPERFLY = { activity: noopfn, virtualPage: noopfn };
  for (const hider of document.querySelectorAll('style[id^=chartbeat-flicker-control]')) {
    hider.remove();
  }
})();
