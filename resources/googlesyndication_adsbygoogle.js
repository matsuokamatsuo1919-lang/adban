// ADBAN: pagead2.googlesyndication.com/pagead/js/adsbygoogle.js の代わり。広告は出さず、「読み込めた」ように見せるだけ。
(function () {
  'use strict';
  const init = () => {
    window.adsbygoogle = { loaded: true, push() {} };
    const slots = document.querySelectorAll('.adsbygoogle');
    const css = 'height:1px!important;max-height:1px!important;max-width:1px!important;width:1px!important;';
    for (let i = 0; i < slots.length; i++) {
      const id = `aswift_${i}`;
      if (document.querySelector(`iframe#${id}`) !== null) continue;
      const frame = document.createElement('iframe');
      frame.id = id;
      frame.style = css;
      const inner = document.createElement('iframe');
      inner.id = `google_ads_frame${i}`;
      frame.appendChild(inner);
      slots[i].appendChild(frame);
      slots[i].setAttribute('data-adsbygoogle-status', 'done');
    }
  };
  if (document.querySelectorAll('.adsbygoogle').length === 0 && document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
