// ADBAN: NitroPay の広告スクリプトの代わり。広告は作らない。
(function () {
  if (window.nitroAds) return;
  const noopfn = function () {}.bind();
  window.nitroAds = { createAd: noopfn, queue: [] };
})();
