// YouTube 自身の計測通信を、静的ルールのブロックより優先して許可する動的ルール。
// YouTube のページは、同じ要求を「検査用の URL」と「基準の URL」に 3 回ずつ送り、応答が食い違うと広告ブロッカーありと判定する
// （2026-11 の kevlar_base の FgL / j2s。組み合わせは api/stats/atr または qoe と generate_204 / feed/download など）。
// 実測では、ブロックされた qoe（クエリ付き）が基準の 204 と食い違っていた。計測通信が 1 つでも失敗すると、この検査の材料になる。
// 広告の本体は content/yt-main.js が取り除くので、ここで許可しても広告は出ない。
// regexFilter は Chrome の RE2 で使える書き方だけにする（後読み・後方参照は不可）。

const YOUTUBE_DOMAINS = ['youtube.com', 'youtube-nocookie.com'];
const PRIORITY = 1000; // 静的ルールの最大 priority は 3

// ids: { youtubeFirstParty, youtubeGoogle }（動的ルールの ID）
export function youtubeAllowRules(ids) {
  return [
    {
      id: ids.youtubeFirstParty,
      priority: PRIORITY,
      action: { type: 'allow' },
      condition: {
        initiatorDomains: YOUTUBE_DOMAINS,
        requestDomains: YOUTUBE_DOMAINS,
        // api/stats/ 配下は検査に使うパスが変わっても効くよう、まとめて許可する（atr・qoe・ads など）
        regexFilter: '^https://[^/]+/(api/stats/|ptracking|generate_204|pagead/)',
      },
    },
    {
      id: ids.youtubeGoogle,
      priority: PRIORITY,
      action: { type: 'allow' },
      condition: {
        initiatorDomains: YOUTUBE_DOMAINS,
        regexFilter: '^https://www\\.google\\.[a-z.]+/pagead/(lvz|1p-user-list/)',
      },
    },
  ];
}
