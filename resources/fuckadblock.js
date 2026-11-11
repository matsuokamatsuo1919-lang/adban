// ADBAN: FuckAdBlock / BlockAdBlock（広告ブロッカー検出ライブラリ）の代わり。いつも「検出しなかった」と答える。
(function () {
  'use strict';
  const noop = function () {};
  function Fab() {}
  Fab.prototype.check = noop;
  Fab.prototype.clearEvent = noop;
  Fab.prototype.emitEvent = noop;
  Fab.prototype.on = function (detected, fn) {
    if (!detected) fn();
    return this;
  };
  Fab.prototype.onDetected = function () {
    return this;
  };
  Fab.prototype.onNotDetected = function (fn) {
    fn();
    return this;
  };
  Fab.prototype.setOption = noop;
  Fab.prototype.options = { set: noop, get: noop };
  const fab = new Fab();
  for (const [name, value] of [
    ['FuckAdBlock', Fab],
    ['BlockAdBlock', Fab],
    ['SniffAdBlock', Fab],
    ['fuckAdBlock', fab],
    ['blockAdBlock', fab],
    ['sniffAdBlock', fab],
  ]) {
    if (Object.prototype.hasOwnProperty.call(window, name)) window[name] = value;
    else Object.defineProperty(window, name, { get: () => value, set: noop });
  }
})();
