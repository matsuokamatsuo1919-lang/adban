// ADBAN: Google Publisher Tag（gpt.js）の代わり。広告は出さず、ページが呼ぶ関数だけをそろえる。
(function () {
  'use strict';
  const noop = function () {};
  const self = function () {
    return this;
  };
  const nothing = () => null;
  const none = () => [];
  const empty = () => '';

  const listeners = { addEventListener: self, removeEventListener: self };
  const companionAdsService = { ...listeners, enableSyncLoading: noop, setRefreshUnfilledSlots: noop };
  const contentService = { ...listeners, setContent: noop };

  function PassbackSlot() {}
  Object.assign(PassbackSlot.prototype, {
    display: noop,
    get: nothing,
    set: self,
    setClickUrl: self,
    setTagForChildDirectedTreatment: self,
    setTargeting: self,
    updateTargetingFromMap: self,
  });

  function Slot(adUnitPath = '', size = [], divId = '') {
    this.adUnitPath = String(adUnitPath);
    this.size = size;
    this.divId = String(divId ?? '');
  }
  Object.assign(Slot.prototype, {
    addService: self,
    clearCategoryExclusions: self,
    clearTargeting: self,
    defineSizeMapping: self,
    get: nothing,
    getAdUnitPath() {
      return this.adUnitPath;
    },
    getAttributeKeys: none,
    getCategoryExclusions: none,
    getConfig: nothing,
    getDomId() {
      return this.divId;
    },
    getResponseInformation: nothing,
    getSizes: none,
    getSlotElementId() {
      return this.divId;
    },
    getSlotId: self,
    getTargeting: none,
    getTargetingKeys: none,
    set: self,
    setCategoryExclusion: self,
    setClickUrl: self,
    setCollapseEmptyDiv: self,
    setConfig: noop,
    setForceSafeFrame: self,
    setSafeFrameConfig: self,
    setTargeting: self,
    updateTargetingFromMap: self,
  });

  const slots = [];
  const pubAdsService = {
    ...listeners,
    clear: noop,
    clearCategoryExclusions: self,
    clearTagForChildDirectedTreatment: self,
    clearTargeting: self,
    collapseEmptyDivs: noop,
    defineOutOfPagePassback: () => new PassbackSlot(),
    definePassback: () => new PassbackSlot(),
    disableInitialLoad: noop,
    display: noop,
    enableAsyncRendering: noop,
    enableLazyLoad: noop,
    enableSingleRequest: noop,
    enableSyncRendering: noop,
    enableVideoAds: noop,
    get: nothing,
    getAttributeKeys: none,
    getSlots: () => slots.slice(),
    getTargeting: none,
    getTargetingKeys: none,
    isInitialLoadDisabled: () => false,
    refresh: noop,
    set: self,
    setCategoryExclusion: self,
    setCentering: noop,
    setCookieOptions: self,
    setForceSafeFrame: self,
    setLocation: self,
    setPrivacySettings: self,
    setPublisherProvidedId: self,
    setRequestNonPersonalizedAds: self,
    setSafeFrameConfig: self,
    setTagForChildDirectedTreatment: self,
    setTargeting: self,
    setVideoContent: self,
    updateCorrelator: noop,
  };

  function SizeMappingBuilder() {
    this.mapping = [];
  }
  SizeMappingBuilder.prototype.addSize = function (viewport, sizes) {
    this.mapping.push([viewport, sizes]);
    return this;
  };
  SizeMappingBuilder.prototype.build = function () {
    return this.mapping;
  };

  const define = (...args) => {
    const slot = new Slot(...args);
    slots.push(slot);
    return slot;
  };

  const gpt = window.googletag || {};
  const queued = Array.isArray(gpt.cmd) ? gpt.cmd.slice() : [];
  Object.assign(gpt, {
    apiReady: true,
    pubadsReady: true,
    companionAds: () => companionAdsService,
    content: () => contentService,
    defineOutOfPageSlot: define,
    defineSlot: define,
    destroySlots: () => true,
    disablePublisherConsole: noop,
    display: noop,
    enableServices: noop,
    enums: { OutOfPageFormat: {}, TrafficSource: {} },
    getConfig: nothing,
    getVersion: empty,
    openConsole: noop,
    pubads: () => pubAdsService,
    setAdIframeTitle: noop,
    setConfig: noop,
    sizeMapping: () => new SizeMappingBuilder(),
  });
  // 広告の準備ができたら動かす処理（googletag.cmd）は、すぐに動かす
  gpt.cmd = [];
  gpt.cmd.push = function (...fns) {
    for (const fn of fns) {
      try {
        if (typeof fn === 'function') fn.call(window);
      } catch {}
    }
    return 1;
  };
  window.googletag = gpt;
  gpt.cmd.push(...queued);
})();
