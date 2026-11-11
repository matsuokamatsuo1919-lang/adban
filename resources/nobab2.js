// ADBAN: BlockAdBlock 系の検出（adclixx.net などの広告配信元が配る版）を無効にする。
// その配信元から読み込まれたときだけ働く。（uBlock Origin の nobab2.js に合わせた）
(function () {
  'use strict';
  const script = document.currentScript;
  if (script === null) return;
  const src = script.src;
  if (typeof src !== 'string') return;
  const re = /^https?:\/\/[\w-]+\.(adclixx\.net|adnetasia\.com|adtrackers\.net|bannertrack\.net)\/./;
  if (!re.test(src)) return;
  window.nH7eXzOsG = 858;
})();
