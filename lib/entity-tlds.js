// フィルターのドメイン指定の「example.*」（エンティティ）を、実在するドメインに展開するときの TLD の一覧。
// uBlock Origin は公開サフィックスのすべてに一致させるが、declarativeNetRequest にはワイルドカードがないので、
// よく使われるものだけに絞る。ここにない TLD のサイトでは、そのフィルターは効かない（止めすぎることはない）。
export const ENTITY_TLDS = [
  'com', 'net', 'org', 'info', 'biz', 'io', 'co', 'tv', 'me', 'cc', 'to', 'xyz', 'online', 'site', 'club', 'live',
  'app', 'dev', 'pro', 'top', 'vip', 'link', 'fm', 'ws', 'eu', 'us', 'ca', 'uk', 'co.uk', 'org.uk', 'au', 'com.au',
  'nz', 'co.nz', 'de', 'fr', 'es', 'it', 'nl', 'be', 'at', 'ch', 'se', 'no', 'dk', 'fi', 'pl', 'cz', 'ru', 'ua', 'tr',
  'com.tr', 'gr', 'pt', 'ro', 'hu', 'jp', 'co.jp', 'ne.jp', 'or.jp', 'kr', 'co.kr', 'cn', 'com.cn', 'tw', 'com.tw',
  'hk', 'com.hk', 'sg', 'com.sg', 'in', 'co.in', 'id', 'co.id', 'th', 'co.th', 'vn', 'com.vn', 'my', 'com.my', 'ph',
  'br', 'com.br', 'mx', 'com.mx', 'ar', 'com.ar', 'cl', 'co.za', 'ng', 'il', 'co.il', 'sa', 'ae', 'eg',
];

// 1 つのフィルターが展開してよいドメインの数の上限（TLD の一覧より多いのは、1 つのフィルターに複数のエンティティがあるとき）
export const MAX_ENTITY_DOMAINS = 500;

// スクリプレットの example.*（エンティティ）を、service worker が match pattern（*://*.example.TLD/*）に展開するときの TLD。
// 要素隠し・手続き型は実行時に判定する（lib/hosts.js の entityChain）ので、これは使わない。
// 展開した数が増えると、registerContentScripts にかかる時間が急に増える（実測: 約 1,560 個の example.* に対して
// 展開なし 4.6 秒 / 12 TLD 9 秒 / 24 TLD 12 秒 / 48 TLD 34 秒 / 95 TLD 60 秒超）。そのため、
// リスト（uBO・AdGuard 日本語・Unbreak）のスクリプレットが載せている約 2 万 3 千サイトの TLD を数えて、
// 多い順の上位 24 個（それらのサイトの約 91%）と、日本のサイト向けの co.jp の 25 個に絞る。ここにない TLD のサイトでは、example.* のスクリプレットは効かない（止めすぎることはない）。
export const SCRIPTLET_ENTITY_TLDS = [
  'com', 'net', 'org', 'co.uk', 'de', 'xyz', 'pl', 'me', 'tv', 'it', 'jp', 'co.jp', 'in', 'to', 'cc', 'info', 'io', 'co',
  'fr', 'top', 'pro', 'ca', 'club', 'live', 'site',
];
