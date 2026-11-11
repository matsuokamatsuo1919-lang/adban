// フィルターの $redirect= で使える「何もしない偽物」のファイル（resources/ フォルダー）。
// 広告のスクリプトを止めると「読み込みに失敗した＝広告ブロッカーがある」と判断するサイトがあるため、
// 止める代わりにこれを読み込ませる。名前と別名は uBlock Origin・AdGuard のものに合わせてある。

const RESOURCES = {
  'noop.js': ['noopjs', 'abp-resource:blank-js'],
  'noop.txt': ['nooptext', 'empty'],
  'noop.html': ['noopframe'],
  'noop.css': ['noopcss'],
  'noop.json': ['noopjson'],
  '1x1.gif': ['1x1-transparent.gif'],
  '2x2.png': ['2x2-transparent.png'],
  '3x2.png': ['3x2-transparent.png'],
  '32x32.png': ['32x32-transparent.png'],
  'noop-vast2.xml': ['noopvast-2.0'],
  'noop-vast3.xml': ['noopvast-3.0'],
  'noop-vast4.xml': ['noopvast-4.0'],
  'noop-vmap1.xml': ['noopvmap-1.0', 'noop-vmap1.0.xml'],
  'googlesyndication_adsbygoogle.js': ['googlesyndication.com/adsbygoogle.js', 'googlesyndication-adsbygoogle'],
  'googletagservices_gpt.js': ['googletagservices.com/gpt.js', 'googletagservices-gpt'],
  'google-analytics_analytics.js': [
    'google-analytics.com/analytics.js',
    'google-analytics',
    'googletagmanager_gtm.js',
    'googletagmanager.com/gtm.js',
    'googletagmanager-gtm',
  ],
  'amazon_apstag.js': ['amazon-adsystem.com/aax2/apstag.js', 'amazon-apstag'],
  'fuckadblock.js': ['fuckadblock.js-3.2.0', 'prevent-fab-3.2.0'],
  'prebid-ads.js': [],
  'popads.js': ['popads.net.js', 'popads-dummy.js'],
  'scorecardresearch_beacon.js': ['scorecardresearch.com/beacon.js', 'scorecardresearch-beacon'],
  'doubleclick_instream_ad_status.js': ['doubleclick.net/instream/ad_status.js'],
  'google-ima.js': ['google-ima3'],
  'noop-0.1s.mp3': ['noopmp3-0.1s'],
  'noop-1s.mp4': ['noopmp4-1s'],
  'fingerprint2.js': [],
  'nobab2.js': [],
  'chartbeat.js': [],
  'hd-main.js': [],
  'adthrive_abd.js': [],
  'nitropay_ads.js': [],
  'sensors-analytics.js': [],
  'amazon_ads.js': ['amazon-adsystem.com/aax2/amzn_ads.js', 'amazon-adsystem-amzn_ads'],
};

const BY_NAME = new Map();
for (const [file, aliases] of Object.entries(RESOURCES)) {
  for (const name of [file, ...aliases]) BY_NAME.set(name, file);
}

/** resources/ にあるファイル名の一覧。 */
export const RESOURCE_FILES = Object.keys(RESOURCES);

/** $redirect= の名前を、declarativeNetRequest の extensionPath にする。用意していない名前は null。 */
export function redirectPath(name) {
  const file = BY_NAME.get(name);
  return file ? `/resources/${file}` : null;
}
