// ADBAN: amazon-adsystem.com/aax2/amzn_ads.js の代わり。広告は取得せず、関数だけ用意する。
(function () {
  'use strict';
  const w = window;
  if (w.amznads) return;
  const noopfn = function () {}.bind();
  const names = [
    'appendScriptTag', 'appendTargetingToAdServerUrl', 'appendTargetingToQueryString', 'clearTargetingFromGPTAsync',
    'doAllTasks', 'doGetAdsAsync', 'doTask', 'detectIframeAndGetURL', 'getAds', 'getAdsAsync', 'getAdForSlot',
    'getAdsCallback', 'getDisplayAds', 'getDisplayAdsAsync', 'getDisplayAdsCallback', 'getKeys', 'getReferrerURL',
    'getScriptSource', 'getTargeting', 'getTokens', 'getValidMilliseconds', 'getVideoAds', 'getVideoAdsAsync',
    'getVideoAdsCallback', 'handleCallBack', 'hasAds', 'renderAd', 'saveAds', 'setTargeting',
    'setTargetingForGPTAsync', 'setTargetingForGPTSync', 'tryGetAdsAsync', 'updateAds',
  ];
  const amznads = {};
  for (const n of names) amznads[n] = noopfn;
  w.amznads = amznads;
  w.amzn_ads = w.amzn_ads || noopfn;
  w.aax_write = w.aax_write || noopfn;
  w.aax_render_ad = w.aax_render_ad || noopfn;
})();
