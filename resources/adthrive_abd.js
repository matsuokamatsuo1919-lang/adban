// ADBAN: AdThrive の広告ブロッカー検出用。「ブロッカーなし」の印を 30 秒だけ Cookie に置く。
(() => {
  const d = new Date(Date.now() + 30000);
  document.cookie = `__adblocker=false; expires=${d.toUTCString()}; path=/`;
})();
