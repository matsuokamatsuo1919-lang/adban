// ADBAN: comScore（beacon.js）の代わり。
(function () {
  'use strict';
  window.COMSCORE = {
    purge() {
      window._comscore = [];
    },
    beacon() {},
  };
})();
