# ADBAN 計測ハーネス (tools/e2e)

拡張機能を実際に入れた Chrome を自動で動かし、さまざまなサイトで「広告がどれだけ残るか」「広告ブロッカー検出に引っかかるか」「ページが壊れていないか」を数値と画面写真で測る道具。拡張機能を改善するたびに再計測して、改善を数字で確かめるために使う。

npm の依存は無い(Node 24 の組み込み機能だけ。Puppeteer / Playwright は使わない)。

## 使い方

```
node tools/e2e/run.mjs                       # 全サイト + 検出ページ、baseline と adban の両方
npm run e2e -- --only detector               # 広告ブロック検出ページだけ
node tools/e2e/run.mjs --only jp-news        # カテゴリで絞る
node tools/e2e/run.mjs --only asahi.com,cnn  # URL の一部(カンマ区切りで複数)
node tools/e2e/run.mjs --mode adban          # 拡張機能ありだけ
node tools/e2e/run.mjs --quick               # 代表 14 サイト + 検出ページ(約 2 分)。改善の確認用
node tools/e2e/run.mjs --youtube             # YouTube の広告秒数も測る(youtube-videos.json の全動画、1 本 45 秒)
node tools/e2e/youtube.mjs --seconds 45      # YouTube だけ単体で
node tools/e2e/report.mjs <out の日時ディレクトリ>   # report.json から report.md を作り直す
node tools/e2e/compare.mjs <前の out> <後の out>      # 2 回の計測の差分 compare.md を作る
node tools/e2e/rules-check.mjs                        # 規則(declarativeNetRequest)が実際に読み込まれているかの自己点検
```

改善の確かめ方(典型): `node tools/e2e/run.mjs --quick`(拡張機能を直す前)→ 直す → `node tools/e2e/run.mjs --quick` → `node tools/e2e/compare.mjs <前> <後>`。広告の出方は実行ごとに揺れるので、差が 2 件以下のものは compare.md で「変化小」と書かれる。

| オプション | 既定 | 内容 |
|---|---|---|
| `--mode adban\|baseline\|both` | both | baseline は拡張機能なしの同じ Chrome |
| `--sites <json>` | tools/e2e/sites.json | `{url, category, note}` の配列 |
| `--only <語>` | なし | カテゴリ名、または URL / 検出ページ名の一部。`detector` で検出ページだけ |
| `--out <dir>` | tools/e2e/out/<日時>/ | 出力先 |
| `--concurrency N` | 3 | モードごとの同時タブ数(両モードは並行して動く) |
| `--settle <秒>` | 8 | 読み込み後、広告が出るのを待つ秒数 |
| `--youtube-file <json>` | youtube-videos.json | `--youtube` の動画一覧ファイル(相対パスはリポジトリのルート基準。例: `tools/e2e/youtube-videos-extra.json`) |
| `--quick` | - | sites.json で `"quick": true` の代表サイト(14 件)+ 検出ページだけ |
| `--youtube` / `--video <url>` | - | YouTube の計測(動画ごとに 45 秒)。動画一覧は `youtube-videos.json`(sites.json とは別枠) |
| `--no-detectors` | - | 検出ページを測らない |
| `--headed` | - | headless をやめ、画面外(x=-2400)のウィンドウで動かす |

出力(out/<日時>/):

- `report.md` … 人が読むレポート(下の「結果の読み方」)
- `detectors/<ページ>/<mode>/` … 検出ページごとの console.json、失敗・ブロック・差し替えになったリクエスト(クエリなし)problem-requests.json。detectadblock.com だけは、ページが読み込む inline / 外部スクリプトのソース(各 30KB まで)も `scripts/` に保存する
- `report.json` … 全データ(サイトごとの通信、上位の第三者ホスト、広告らしい要素の先頭 10 件など)
- `shots/baseline/*.png`, `shots/adban/*.png` … viewport(1366x800)の画面写真。検出ページは縦長(最大 3500px)

## 仕組み

### 拡張機能の読み込み方法

Chrome 157(ブランド版)では `--load-extension` が既定で無効なので、次の順に試して最初に動いたものを使う(`lib/manager.mjs` の `EXT_METHODS`)。

1. **採用: `--remote-debugging-pipe --enable-unsafe-extension-debugging` で起動し、CDP の `Extensions.loadUnpacked({path})` で読み込む。** この環境(Chrome 157、headless=new、Windows)で動いた。ポートを開かないので他のプロセスから見えず、fd 3 / fd 4 のパイプ(JSON + `\0` 区切り)だけで通信する。
2. `--disable-features=DisableLoadExtensionCommandLineSwitch --load-extension=<dir>` … この環境のブランド版 Chrome 157 では拡張機能が読み込まれず失敗した(フォールバックとして残している)。
3. Edge(`msedge.exe`)で同じことを試す(フォールバック)。

Chrome 内蔵のコンポーネント拡張機能の service worker も混ざって見えるため、`chrome.runtime.getManifest().name === 'ADBAN'` で自分の拡張機能の service worker を見分けている。

### 起動の流れ

1. リポジトリのルートを一時ディレクトリへコピー(`tools/`・`node_modules`・`.git`・`_metadata` は除く)。他の担当が本体を編集していても計測が壊れない。
2. `os.tmpdir()` に新しい `--user-data-dir` を作って Chrome を起動する。普段のプロファイルには触れず、終了時にプロファイルとコピーを削除する。既存の Chrome プロセスは kill しない(自分が起動した PID だけ終了する)。
3. 拡張機能の service worker に `Runtime.evaluate` し、`chrome.scripting.getRegisteredContentScripts()` の件数が 0 より大きく 2 秒間変わらなくなるまで待つ(スクリプレットの登録待ち)。通常 4 秒前後。有効なルールセットも記録する。
4. 各サイトを新しいタブで開く。User-Agent から `HeadlessChrome` を消す(`Network.setUserAgentOverride`)。viewport は 1366x800。

### 1 サイトの計測

- `Page.navigate` → load を待つ(最大 20 秒)→ `--settle` 秒待つ → ページ高さの 0%→50%→100%→0% を各 1 秒でスクロール(遅延読み込みの広告を発火)→ DOM を調べる → 画面写真。1 サイト 45 秒でタイムアウトし、`error` を記録して次へ進む。Chrome が落ちたら起動し直して 1 回やり直す。
- 通信は `Network.*` を、cross-origin iframe やワーカーも含めて自動アタッチして集める。`net::ERR_BLOCKED_BY_CLIENT` の `loadingFailed` を「止めた数」とする。
- 同意ポップアップ・ログイン・フォーム送信・ダウンロードはしない(触らない)。

## 結果の読み方

- **req(全リクエスト数)**: base / adban。adban のほうが大きく減るのが理想。広告スクリプトを止めると、その先の子リクエストも発生しなくなるので、減り方は「ブロック数」より大きいのが普通。
- **通信の 3 分類**(adban):
  1. **ブロック** … `net::ERR_BLOCKED_BY_CLIENT` で止まったもの。baseline では必ず 0。ここが 0 なら拡張機能が効いていない(読み込み失敗)ので、まずそこを疑う。
  2. **差し替え** … declarativeNetRequest の redirect で、拡張機能の resources/ にある「何もしない偽物」(googlesyndication_adsbygoogle.js、googletagservices_gpt.js、google-analytics_analytics.js など)に置き換えられたもの。`Network.requestWillBeSent` の `redirectResponse` があり、リダイレクト先が `chrome-extension://` のものを数え、元の URL のホストで集計する。
  3. **通過** … 上のどちらでもなく、そのままサーバーへ届いたもの。「通過した広告・トラッカーらしい第三者ホスト」の表は、この通過だけで作る(URL 例はクエリを除いたパスまで 2 件)。差し替えは別の表。
- **残った広告らしい**: 見えている(面積 > 0、display/visibility/opacity で隠れていない)広告っぽい iframe(src ホストや id/name/class が広告語・広告ネットワーク名に合致)と、id/class に広告語を含む 30x30px 以上の要素(入れ子は外側だけ)の合計。base / adban。`report.json` の `dom.adIframeList` / `dom.adElemList` に先頭 10 件(タグ・id・class・src・サイズ)がある。**ヒューリスティックなので偽陽性がある**(`pr` や `promo` を含むクラス名の記事枠など)。数が 0 になることより、baseline に対する減り方と、残った要素の中身を見るのに使う。
- **空の広告枠**: 見えている要素で、自身のテキストが「Advertisement / Ad / Ads / Sponsored / 広告 / PR / スポンサー(ド)(リンク)」のどれかちょうどで、親(要素が 1 つだけなら最大 2 段上まで)の枠の中に、見えている(20x20px 以上の)img / iframe / video / canvas / svg が 1 つも無いもの。広告の中身だけ消えて「広告」の札と空白が残った状態(weather.com で見つかった)。先頭 5 件(タグ、class、枠のサイズ)は `dom.emptyAdSlotList`。テキストだけの広告(「PR」付きのテキストリンクなど)も数えてしまうので、画面写真で確かめる。
- **本文長比**: adban の `body.innerText` の長さ / baseline。0.7 未満なら本文が欠けている可能性があるが、**広告の中身が消えて文字数が減っただけのこともある**(weather.com は 0.57 だが、空の「Advertisement」枠が残っていただけ)。空の広告枠の数と画面写真を合わせて判断する。
- **コンソールエラー**: base / adban。adban で増えていたら、ブロックの副作用で JS が落ちている可能性。ネットワークエラー(Failed to load resource)は数えていない(止めた通信が全部エラー扱いになるため)。
- **検出メッセージ**: 「広告ブロッカーを無効に」「ad blocker」「adblock」「広告ブロック」「ホワイトリスト」などを含む、見えている要素のテキスト(記事リンク・見出しの中は除く)。`(baseline でも)` と付いていれば、サイト側の通常の文言なので検出ではない。`(スクロール固定)` は body / html が `overflow:hidden` 等で固定されている兆候。
- **同意画面**: Cookie・同意のダイアログ(role=dialog、id/class に cookie・consent・privacy などを含む要素で、テキストに cookie / consent / 同意 / プライバシー / 個人情報 を含み、画面の 8% 以上を占めるもの。Guardian のような cross-origin の同意 iframe も含む)が見えているとき、`[同意画面]` と書く。スクロール固定がこれによるものなら `[同意画面・スクロール固定]` となり、広告ブロッカーの検出とは別扱い。
- **通過した広告・トラッカーらしい第三者ホスト**: adban で止められず通ったホストのうち、広告・計測らしい名前のものを全サイトで集計。次にブロックすべきルールの候補。
- **detector**: 広告ブロック検出・テストページの結果文字列と点数。`pct` は「止められた割合」の目安。
  - turtlecute(d3ward の後継): 130 個中いくつ止めたか。
  - AdBlock Tester: ページ自身の点数が無いので、passed / (passed + failed) を点数にしている。
  - FiveFilters / FuckAdBlock demo: 検出されたかどうか。FuckAdBlock は「AdBlock is enabled」と出ると検出された。出ない(= not enabled)なら回避できている。
  - detectadblock.com: 「You're blocking ads」が出ると、ブロッカーが検出されている。
  - ads-blocker.com: ページ内のローカルなテスト(Run test ボタンを 1 回押す)。
  - Can You Block It (extreme): 点数が無く、見えている iframe 数と画面写真で判断する。
  - turtlecute と ads-blocker.com は項目別の結果(`items`)も取り出し、report.md に「止められていない項目」を載せる。
- **YouTube**: `youtube-videos.json` の動画ごとに 45 秒間、1 秒おきに `#movie_player.ad-showing`、`.ytp-ad-player-overlay`、`.ytp-ad-text`、スキップボタン、`video.playbackRate` / `muted` を記録し、広告が映った秒数を出す。広告ブロッカーの警告(`ytd-enforcement-message-view-model`、「広告ブロッカー」「Ad blockers」などを含むダイアログ、`yt-playability-error-supported-renderers` / `.ytp-error` の再生エラー)が出たかも記録する。**baseline で広告が 0 秒だった動画は「比較にならない」として判断から除く**(広告の出方は動画・時間帯・地域・bot 判定による)。止まった再生は `video.play()`、動画中央の本物のマウスクリック(広告表示中は誤クリックを避けて `k` キー)で再開を試みる。

## 規則の自己点検(rules-check.mjs)

拡張機能を入れた Chrome の service worker の中で、次を調べる。
- `getEnabledRulesets()` と、`rules/*.json` の件数。`getAvailableStaticRuleCount()` から、ルールセットを 1 つずつ有効化して実際に読み込まれた件数を数え、ファイルの件数との差(= Chrome が無視したルール)を出す。`MAX_NUMBER_OF_STATIC_RULES` は新しい Chrome では未定義なので、全体の上限 300000 + `GUARANTEED_MINIMUM_STATIC_RULES` で代用している。
- `isRegexSupported` で regexFilter が使えるか、redirect 先の `extensionPath` が実在するか。
- `testMatchOutcome` で代表的な URL(Prime Video の GetPlaybackResources の 2 ルール、広告・計測スクリプトの差し替え、ブロック、日本の広告、対照)にルールが効くか。`$document`(main_frame の block)と `$csp`(Content-Security-Policy の modifyHeaders)は、rules/ から該当ルールを探して試し、無ければ「未確認」と書く。
結果は out/<日時>_rules/rules-check.md と .json。

## 制限

- 公開サイトの内容は日々変わる。同じ日・同じ時間帯に baseline と adban を並行して測るので比較はできるが、実行ごとの絶対値は揺れる(広告のオークション、A/B テスト、地域、bot 判定による)。変化を見るときは複数回回して傾向を見ること。
- 未ログイン・Cookie なし・日本語環境(`ja-JP`)・headless の状態での結果。ログインが必要な画面、同意ポップアップの先は測らない。
- 通信は `Network.*` で見ているので、`ERR_BLOCKED_BY_CLIENT` は declarativeNetRequest によるブロック(や Chrome 自身のブロック)を含む。baseline でもまれに 0 でないことがあれば、Chrome 側の機能(Safe Browsing など)。
- 画面上の広告判定は名前ベース。画像だけの広告や、名前が難読化された広告は拾えない。逆に広告と無関係な `ad` 系のクラス名を拾うことがある。判断に迷ったら画面写真を見ること。
- 第三者の判定は簡易(末尾 2 ラベル、`co.jp` などは 3 ラベル)。同じ会社の別ドメイン(例: `yimg.jp`)は第三者として数える。
- Shadow DOM の中は DOM 検査の対象外。
- 検出ページ(adblock-tester、turtlecute など)の結果は、完了を「結果が数秒間変わらない」で判定している。回線や負荷で未完了のまま確定することがまれにある(baseline の turtlecute が 7 件のときと 54 件のときがあった)。
- `d3ward.github.io/toolz/adblock.html` は 2025 年にアーカイブされてテスト本体が無くなっていたため、後継の `adblock.turtlecute.org` に置き換えた。BlockAdBlock の公式サイト(blockadblock.com)はデモを持たない宣伝ページなので、FuckAdBlock のデモ(fuckadblock.sitexw.fr)を使っている。
- Windows 専用(`taskkill` と Chrome / Edge の既定パスを使う)。

## ファイル

- `run.mjs` … 実行本体(引数、並行実行、再起動、レポート出力)
- `sites.json` … 計測するサイト
- `detectors.mjs` … 検出テストページと、結果を取り出す評価コード
- `youtube.mjs` / `youtube-videos.json` … YouTube の広告秒数(単体実行も可)。動画の一覧は別ファイル
- `compare.mjs` … 2 回の計測の差分(compare.md)
- `rules-check.mjs` … 規則の読み込みの自己点検(`$csp` の全件確認を含む)
- `csp-check.mjs` … `$csp`(modifyHeaders)が実機で効くかの確認
- `sites-extra.json` / `youtube-videos-extra.json` … 追加のサイトと動画
- `report.mjs` … report.json / report.md の生成
- `lib/browser.mjs` … Chrome の起動、CDP パイプ、拡張機能の読み込み、後片付け
- `lib/manager.mjs` … モードごとのブラウザ管理(落ちたら再起動)
- `lib/measure.mjs` … 1 ページの計測(通信集計、DOM 検査、スクリーンショット)

## 規則の自己点検と $csp の実機確認

### rules-check.mjs
```
node tools/e2e/rules-check.mjs                          # 規則の読み込み(件数・正規表現・redirect 先)と testMatchOutcome
node tools/e2e/rules-check.mjs --turtlecute <out>       # turtlecute で止められていない項目に、ルールが当たるかも調べる
```
拡張機能を入れた Chrome の service worker の中から調べる。結果は out/<日時>_rules/rules-check.md と .json。
- ルールセットを 1 つずつ有効化して、実際に読み込まれた静的ルール数をファイルの件数と比べる(差があれば Chrome が無視したルールがある)。regexFilter は `isRegexSupported` で全件確認。
- `testMatchOutcome` で代表的な URL(Prime Video の GetPlaybackResources、広告スクリプトの差し替え・ブロック、日本の広告、`$document`、`$csp`)に効くか。
- **`$csp`(modifyHeaders で Content-Security-Policy を足すルール)は全件を確認する。** testMatchOutcome の呼び方が肝で、実機(csp-check.mjs)で確かめた次の形を使う。
  - `requestDomains` のルール … `type: main_frame`、initiator なし、URL は対象ドメイン。
  - `initiatorDomains` のルール … `type: sub_frame`、initiator も URL も対象ドメイン(同一ドメインの iframe)。ページを直接開く main_frame には initiator が無いので、initiatorDomains のルールは当たらない(`$csp,domain=X` は `requestDomains` にするのが正しい。lib/filters.js 側は修正済み)。
  - `urlFilter` だけのルール(`||name.*^` など)… 対象ホストの URL。

### csp-check.mjs
```
node tools/e2e/csp-check.mjs                               # 動的ルール + 静的ルール全件 + 修正案の確認(静的 44 件で 10 分以上)
node tools/e2e/csp-check.mjs --skip-dynamic --only-ids easylist#2595,ubo#1439   # 指定したルールだけ
```
`$csp` が実機で効くかを、127.0.0.1 の簡単な HTTP サーバー(CSP ヘッダーなしの HTML)で確かめる。
- Chrome に `--host-resolver-rules` を足し、ルールの対象ドメイン(filecrypt.cc など)を 127.0.0.1 に向ける。ルールに当たるホスト名のページを main_frame と sub_frame(iframe)で開き、`Network.responseReceived` の応答ヘッダーに DNR が足した content-security-policy が見えるか、インライン script・外部 script・worker が CSP で止まるか(`securitypolicyviolation`)を見る。
- 動的ルール: customFilters(`||localhost^$csp=...` と `*$csp=...,domain=scoped.test`)を storage.local に入れ、background.js が作る動的ルールで同じ確認をする。
- 静的ルールの initiatorDomains 版と requestDomains 版の違い(main_frame に効くか)を比べる修正案の確認も含む。
- 本体の manifest が存在しないルールファイルを指しているとき(別の担当が編集中など)は、そのルールセットだけを外した manifest のコピーで試す。
- 結果は out/<日時>_csp/csp-check.md と .json。

## 追加サイトと追加の YouTube 動画

- `sites-extra.json` … sites.json と同じ形式で、sites.json に無い種類のサイト(日本の Q&A・辞書・ゲーム・エンタメ・金融・生活・まとめ、英語圏の健康・エンタメ・ゲーム・辞典・金融・旅行、他言語)。`node tools/e2e/run.mjs --sites tools/e2e/sites-extra.json` で計測する。
- `youtube-videos-extra.json` … youtube-videos.json と同じ形式で、広告が出やすい動画 10 本。現在の run.mjs / youtube.mjs は動画一覧のファイルを引数で切り替えられないので、使うときは youtube-videos.json の中身と差し替えるか、`--video <url>` で 1 本ずつ指定する。
