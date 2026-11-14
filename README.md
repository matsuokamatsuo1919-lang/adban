# ADBAN

ウェブサイトの広告とトラッカーをブロックする Chrome / Edge 拡張機能（Manifest V3）です。

- **通信の遮断** — 広告配信やトラッカーのサーバーへの通信を、ブラウザーの `declarativeNetRequest` で止めます。
- **広告枠を隠す** — 通信を止めても残る広告の枠や、ページに直接埋め込まれた広告を CSS で隠します。後から差し込まれる広告にも効きます。
- **ポップアップ広告を閉じる** — `window.open` や `target=_blank` で開かれる広告のタブ（ポップアンダーを含む）を、フィルターの `$popup`（約 3,100 行）に当てはまるものだけ閉じます。ログイン・決済などの正規のポップアップは、フィルターに載っていなければ閉じません。許可リストのサイトでは動きません。
- **空の広告枠と記事広告をたたむ** — 広告の中身が消えたあとに「広告」「Advertisement」「Sponsored」の札だけが残った空の枠と、「PR」「広告」「スポンサード」などの表記がある記事広告のカードを、ページの見た目と構造から判断して隠します（`content/slots.js`、設定画面でそれぞれオフにできます）。誤爆を避けるため条件は保守的で、見出し・リンク・本文の中の語、札が 100 個以上あるページ、ほかのカテゴリ札が複数あるカードなど、広告かどうか曖昧なものは隠しません。
- **YouTube** — プレイヤーに渡る広告の情報を取り除きます。それでも流れた広告は、ミュートしたうえで早送り・スキップします。
- **Prime Video** — 動画の目録（.mpd）から広告の区間を消し、再生情報の要求から広告の予定を外します（uBlock filters のルール）。それでも流れた広告は、ミュートしたうえで 16 倍で早送りし、終わる直前に元の速度に戻します。
- **広告ブロッカー対策への対策** — 「広告ブロッカーを無効にしてください」と表示して閲覧を止めるサイトに、次の 3 つで対処します。
  - **スクリプレット** — 検出するスクリプトをページの中で止めたり、だましたりします（uBlock Origin と同じ `##+js(...)` のフィルター）。対象は、リストに載っている約 2 万 2 千サイトです。
  - **偽物の広告スクリプト** — 広告のスクリプト（Google の gpt.js・adsbygoogle.js など）や検出ライブラリを、止める代わりに何もしない偽物に差し替えます。「広告の読み込みに失敗した＝広告ブロッカーがある」という判定をすり抜けます。
  - **警告を消す** — おとりの広告枠を見せたままにする、警告を隠す、止められたスクロールを戻す、といった見た目の修正（`:style()` / `:remove()`）。
- **要素を選んでブロック** — 残っている広告をクリックで選んで隠せます。画面を覆う警告を選んだときは、止められていたスクロールも元に戻します。
- **サイトごとのオン・オフ**、**自分で書くフィルター**（Adblock Plus と同じ書き方）。

使っているフィルターリスト: ADBAN 基本フィルター（同梱）、EasyList、AdGuard 日本語フィルター、uBlock filters、EasyPrivacy、uBlock filters – Unbreak、uBlock filters – Quick fixes（素早い修正）、uBlock filters – Badware risks（悪質サイト）、Peter Lowe's Ad and tracking server list（広告・トラッカーのサーバー名。開発用のみで、公開版には入りません。下の「ライセンスについての注意」）、uBlock filters – Privacy（トラッカー）、AdGuard DNS フィルター（広告・トラッカーのホスト名。端末メーカーやアプリの分析用ホストなど、ホスト名だけで決まるもの）。

## サポート・ご意見

不具合の報告、広告が残るサイトの報告、ご意見・ご要望は、次の窓口で受け付けています。

- [SUPPORT.md](SUPPORT.md) — 窓口の案内（拡張機能の「問題を報告」ボタンの使い方、書いてはいけないもの）
- [Issues](https://github.com/matsuokamatsuo1919-lang/adban/issues/new/choose) — 広告が残る・表示が壊れる・要望のテンプレート（GitHub のアカウントが必要です）
- [サポートのページ](https://matsuokamatsuo1919-lang.github.io/adban/) — 使い方とよくある質問
- [プライバシーポリシー](https://matsuokamatsuo1919-lang.github.io/adban/privacy) — ADBAN はデータを収集・送信しません

開発に参加するときは [CONTRIBUTING.md](CONTRIBUTING.md) をご覧ください。

## インストール

1. Chrome で `chrome://extensions`（Edge なら `edge://extensions`）を開きます。
2. 右上（Edge は左下）の **デベロッパー モード** をオンにします。
3. **パッケージ化されていない拡張機能を読み込む** を押し、このフォルダーを選びます。
4. ツールバーのパズルのアイコンから ADBAN をピン留めしておくと、ブロック件数が見えて便利です。

## 使い方

ツールバーの ADBAN のアイコンを押すとポップアップが開きます。

| 操作 | 内容 |
| --- | --- |
| 右上のスイッチ | すべてのサイトでのブロックをオン・オフ |
| このサイトでブロックする | 今のサイトだけ止める・再開する（表示が崩れるサイト向け） |
| 要素を選んでブロック | ページ上の広告をクリックして選ぶ。「親要素へ」で範囲を広げ、「ブロック」で保存 |
| 設定 | リストの選択、YouTube の設定、ブロックしないサイト、自分のフィルターの編集 |

アイコンの数字は、今のタブで止めた通信の件数です。全体をオフにすると `OFF` と表示されます。

## フィルターリストを新しくする

広告の配信元や、サイトの広告ブロッカー対策は日々変わる（uBlock の Quick fixes リストは 12 時間ごとに更新される）ので、更新を止めないことが大事です。Node.js が必要です。手で更新するときは次のコマンドです。

```bash
node tools/build-filters.mjs
```

実行すると、ADBAN が `rules/meta.json` の変化に気づいて自動で読み込み直します（下の「自動で取り込む」）。自動で読み込み直したくないときは、設定画面の「リストの更新を自動で取り込む」をオフにして、`chrome://extensions` で ADBAN の再読み込みボタン（↻）を押してください。

- 引数なしは全リストを取得し直します。`--offline` は `filters/base.txt` だけを変換します。`--force` は、取得内容が前回と同じでも書き直します（変換のしくみを直したあとなど）。
- **安全な書き出し**: 全リストの取得と変換が終わってから、一時ディレクトリ `rules/.tmp-build/` にまとめて書き、すべて成功したらファイルを 1 つずつ `rename`（原子的）で置き換えます。`meta.json` は最後です。途中で落ちても `rules/` は元のままです（名前が `_` で始まるディレクトリは Chrome が拒否するので使いません）。一部のリストの取得に失敗しても、ほかは更新し、失敗したリストは前回の内容を使います。
- **変わっていなければ書かない**: 取得した本文の SHA-256 を `meta.json` の各リストの `hash` に持ち、前回と同じリストは書き直しません。全部同じなら `meta.json`（`updated`）も変えないので、無駄な再読み込みが起きません。

### 自動で取り込む（パソコンの定期実行 + 拡張機能の自動再読み込み）

Manifest V3 では、静的ルール（`rules/*.json`）やスクリプレット（content scripts のファイル）を実行時に書き換えられません。そのため、「パソコン側でビルドを定期実行 → 拡張機能が自分の `rules/meta.json` の変化を見て自動で読み込み直す」という形にしています。

**1. パソコン側の定期実行（Windows）** — タスク スケジューラに登録します。現在のユーザーの権限で動くので、管理者権限は要りません（ログオン中だけ動きます）。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File toolsegister-update-task.ps1
```

- 「ADBAN フィルター更新」というタスクが、毎日 1 回（既定は 03:30。`-At 05:00` のように変えられます）と、ログオンの 2 分後に 1 回（その時刻にパソコンが off だったときの取りこぼし対策。`StartWhenAvailable` も有効）、`tools/update-filters.ps1` を実行します。
- `tools/update-filters.ps1` は `node tools/build-filters.mjs` を実行し、出力を `tools/update-filters.log` に日時つきで追記します（200KB を超えたら古い半分を捨てます）。Node.js が見つからないときは、その旨をログに書いて終わります。
- 今すぐ試す: `Start-ScheduledTask -TaskName "ADBAN フィルター更新"`（結果はログで確かめます）。
- 削除: `powershell -NoProfile -ExecutionPolicy Bypass -File toolsegister-update-task.ps1 -Unregister`
- 登録の内容を変えたいときは、もう一度登録のコマンドを実行します（上書きされます）。

**2. 拡張機能の自動再読み込み**（`auto-update.js`） — 起動時に `rules/meta.json` の内容（SHA-256）を覚え、6 時間ごと（`chrome.alarms`）に読み直して、変わっていたら `chrome.runtime.reload()` します。次の安全装置があります。

- ビルドの途中を読み込まない: 変わっていたら、`rules/` の各ファイル（各リストの `.json`・`.cosmetic.json`・`popups.json`・スクリプレットの表と分割ファイル）が読める（JSON として解析できる、途中で切れていない）ことを確かめ、確かめている間に `meta.json` が変わらなかったことも確かめてから再読み込みします。読めなければ 10 分後にやり直します。
- 作業を邪魔しない: ユーザーが 60 秒以上操作していない（`chrome.idle.queryState(60)` が `idle` か `locked`）ときだけ再読み込みします。そうでなければ 10 分後にやり直します（動画の視聴中などには再読み込みしません）。
- 繰り返さない: 再読み込みの直後 5 分間は、また変わっていても再読み込みしません。
- 設定の「リストの更新を自動で取り込む」（`autoReload`、既定はオン）をオフにすると、何もしません。
- 再読み込みしても、すでに開いているタブの content script は古い状態のまま孤立します（拡張機能の仕様です）。ページを開き直すと新しいものが入ります。再読み込みの直後は、開いているタブで要素隠し・スクリプレットが一時的に効かなくなることがあります。
- 必要な権限は `alarms` と `idle` です。

ほかのコマンド:

```bash
node tools/check.mjs
```

```bash
node --test "tools/*.test.mjs"
```

`check.mjs` は生成したルールがブラウザーに受け付けられる形かを点検し、テストはフィルター変換とビルド（`tools/build.test.mjs`。一時ディレクトリの小さなリストで、原子的な書き出しと「変更なし」の判定を確かめる）の動きを確かめます。自動再読み込みの実機確認は `node tools/e2e/auto-update.e2e.mjs`（拡張機能入りの Chrome で、コピーの `meta.json` を書き換えて、再読み込みする・しないを確かめます）です。

## できないこと（広告を 100% 消せない理由）

どの広告ブロッカーにも共通する限界があり、すべての広告を必ず消せるわけではありません。

- **サイト自身が配信する広告** — 記事と同じサーバーから同じ形で届く広告（記事広告・PR 記事など）は、通信では見分けられません。「PR」「広告」などの札が付いて画像とリンクを持つカードは `content/slots.js` が隠しますが、札のないものは見分けられません。見つけたら「要素を選んでブロック」で隠してください。
- **YouTube** — YouTube は広告の出し方を頻繁に変え、広告ブロッカーへの対策もしています。今日効いても、仕様変更で効かなくなることがあります。設定画面で「動画の広告データを取り除く」をオフにすると、警告が出にくくなる代わりに早送りでのスキップだけになります。広告ブロッカーの検出を避けるため、YouTube 自身の計測通信（再生状況の報告など）はブロックしません。
- **Prime Video** — Amazon も広告の出し方をよく変えます。広告の区間を消すルールが効かなくなったときは、早送りでの対処だけになります。早送りは「飛ばす」のではなく、ミュートしたまま速く流すので、広告 1 本につき 1〜3 秒ほどは画面に映ります。また、終わりの 1 秒ほどは本編に食い込まないよう元の速度（ミュートのまま）で流します。
  - 広告の見つけ方は、画面の文字（「広告 1/2 0:15」「Ad 1 of 2 0:30」「広告 あと 15 秒」など）、既知のクラス名、`aria-label` を重ねて使います。操作バーが隠れている間も拾います。
  - 本編を倍速にしないための安全装置: 広告の印が 2 回続けて取れるまで動かない / 印が消えたら次の確認で元に戻す / 一時停止中は何もしない / 倍速にし続ける時間は連続 120 秒・5 分で合計 180 秒まで（超えたら戻し、印がいったん消えるまで何もしない）。
  - **診断の記録** — 広告の実画面が開発者から見えないため、再生中に広告まわりの画面の部品と動画の状態を記録します（設定画面の「Prime Video の診断」。既定でオフです。広告が止まらないときだけ、設定画面で自分でオンにします。オンにしたあとも、いつでもオフにできます）。広告が検出されたとき・動画の状態が急に変わったとき・広告に関わる語が現れたときの前後（直前 10 件・直後 20 件）を最大 5 件、再生 60 秒ごとの記録を最大 10 件、`chrome.storage.local` の `pvDiag` に保存します。先に設定画面の「診断を記録する」をオンにしておき、広告が流れたあとで設定画面を開き、「診断をコピー」を押して貼り付けて送ってください。
    - 保存するもの: video の状態（再生位置・速度・ミュート・大きさ）、広告・スキップの語や時刻を含む短い要素の名前（タグ・class・`data-testid`・見え方・大きさ・広告の語と時刻だけの文字）、検出の結果、広告や再生に関わりそうな通信のホストとパス（クエリなし・ID は伏せる）、ページのパス（ID は伏せる）。
    - 保存しないもの: 作品名・タイトル・`document.title`・プレーヤー全体の文字・アカウント情報・通信のクエリや中身。広告の語と数字・記号だけでできていない文字は「[伏せた]」と記録します。保存先はこのブラウザーの中だけで、送信はされません。
- **広告ブロッカー対策のあるサイト** — 対策できるのは、主にフィルターリストに載っているサイトです。載っていないサイト、サーバー側で判定するサイト、検出のしかたを頻繁に変えるサイトでは、警告が出ることがあります。そのときは次の順に試してください。
  1. 「要素を選んでブロック」で警告を選んで消す（スクロールも戻ります）
  2. リストを新しくする（上の「フィルターリストを新しくする」）
  3. ポップアップで「このサイトでブロックする」をオフにする
- **有料会員向けの制限** — 広告ブロッカーの検出とは別の、記事の有料部分などの制限は解除しません。
- **Manifest V3 の制約** — Chrome の現在の仕組みでは、通信の中身を書き換える高度な処理（uBlock Origin の一部の機能など）は使えません。そのため、フィルターリストのうち再現できない書き方の行（`trusted-` で始まるスクリプレット、HTML の書き換え、プロパティを照合する `:-abp-properties()` など）は読み飛ばしています。
- **自分で書くフィルターの `+js(...)`** — スクリプレットはページより先に動かすため、拡張機能のファイルとして登録する必要があります。そのため、配布リストに入っているものだけが使え、設定画面で自分で書いたものは使えません。
- **YouTube** — YouTube 向けのスクリプレットはリストから使わず、ADBAN 専用の処理だけで対応しています（両方を重ねると検出されやすくなるため）。

## しくみ

```
manifest.json
background.js            service worker。設定に合わせてルールとスクリプレットを切り替え、広告を隠す CSS を入れる
auto-update.js           rules/meta.json の更新を見て、条件がそろえば自動で再読み込みする
popup-blocker.js        広告のポップアップ（$popup）を閉じる。新しく開かれたタブを見張り、URL が当てはまるときだけ閉じる
content/slots.js         空の広告枠と、「PR」などの札のある記事広告をたたむ
content/cosmetic.js      すべてのページで動き、ページ内の class / id を service worker に知らせる。YouTube・Prime Video の広告の早送りと、Prime Video の診断の記録もする
content/scriptlets.js    スクリプレットの本体。対象のサイトでだけ、ページ側（MAIN world）で動く
content/procedural.js    手続き型の要素隠し（:has-text() など）の評価。そのサイトに効くものがあるときだけ動く
content/yt-main.js       YouTube のページ側で広告の情報を取り除く（初回の応答と、実際の URL が /youtubei/v1/ の fetch の応答だけを書き換える。JSON.parse などは包まない）
content/picker.js        「要素を選んでブロック」の画面
resources/               $redirect で差し替える、何もしない偽物（広告スクリプト・透明な画像など）
popup/  options/         ポップアップと設定画面
lib/filters.js           フィルター → declarativeNetRequest ルール・要素隠し・スクリプレットのデータへの変換
lib/cosmetic.js          ページごとに隠す CSS と、手続き型のプログラムを選ぶ
lib/hosts.js             ホスト名まわり（example.* のエンティティを判定する entityChain もここ）
lib/resources.js         $redirect の名前と resources/ のファイルの対応
filters/base.txt         同梱の基本フィルター（手で書いたもの）
rules/                   tools/build-filters.mjs が生成するルール（直接編集しない）
tools/                   ルールの生成・点検・テスト、アイコンの生成、公開用パッケージの作成（make-package.mjs）
LICENSE  THIRD_PARTY_NOTICES.md   GPL v3 の全文と、同梱している第三者のもの（リスト・コード）の一覧
tools/e2e/               拡張機能を入れた Chrome を自動で動かして、広告の残り方・広告ブロッカー検出・壊れを測る計測ツール（使い方は tools/e2e/README.md。`node tools/e2e/run.mjs --quick` で約 3 分）
```

- 隠す CSS はユーザースタイルシート（`origin: 'USER'`）として入れるので、ページ側の `!important` に負けません。
- 「.ad-banner」のような全サイト共通の選択子は数万件あるため、ページに実際に出てきた class / id に当てはまるものだけを入れて、ページを重くしないようにしています。
- **手続き型の要素隠し**（`:has-text()`・`:contains()`・`:-abp-contains()`・`:has()` / `:-abp-has()`（中に手続き型を含むもの）・`:upward()`・`:nth-ancestor()`・`:xpath()`・`:matches-css()`（`-before` / `-after` も）・`:matches-attr()`・`:matches-media()`・`:matches-path()`・`:min-text-length()`・`:others()`・`:not()`（中が手続き型のもの）・`:if()` / `:if-not()`・`:remove()` / `:remove-attr()` / `:remove-class()` / `:style()` との組み合わせ）は、変換のときに「基点の CSS + 演算子の列」の JSON に分けて、service worker がそのサイトに効く分だけを `content/procedural.js` に渡します。評価は MutationObserver で変わった要素だけを調べ直し、1 回の処理は 8 ミリ秒で区切ります。全サイト共通の手続き型（ドメインのないもの）は、ページ全体を調べることになるので使いません。再現できないもの（プロパティの照合 `:-abp-properties()`・`:matches-property()`、正規表現のドメイン指定など）と、ReDoS になりうる正規表現（入れ子の繰り返し・後方参照）は読み飛ばします。
- **空の広告枠・記事広告のたたみ込み**（`content/slots.js`、最上位のページだけ・`document_idle`）— ページの文字を 1 回だけ走査して「札」（短く小さい文字で、`広告`・`Advertisement`・`Sponsored`・`PR` などとちょうど一致するもの。見出し・ボタン・メニュー・リンクの文字・本文の段落や文章の途中の語は除く）を探します。札が 1 つもなければ MutationObserver を作りません。あれば追加されたノードだけを 300 ミリ秒のデバウンスで調べ、1 回の処理は 8 ミリ秒で区切ります。札が 100 個以上あるページは、分類ラベルとみなして何もしません。
  - **空の枠**: 札の親・祖父母のうち、札以外の文字が 20 文字以下で、見える画像・iframe・動画・背景画像が無い最も外側の要素。札から 3 秒待っても中身が入らず、札より 24px 以上高く、画面の 60% 未満なら `display:none !important` にします。あとから中身が入ったら元に戻します。
  - **記事広告**: 札から親をたどり、見える画像と `<a href>` を持ち、文字が 200 文字以下、画面の 40% 未満の最も内側のカード（`<li>`・`<article>`・`<a>`・`<div>`）を隠します。`body`・`main`・`nav`・`header`・`footer` には到達させず、カテゴリ名のような短い札が複数あるカードは隠しません。サムネイルに画像で「PR」を描くサイト向けに、class 名が `pr`・`〜-pr`・`〜_pr`・`sponsored` のもの、alt が札の小さい画像も札とみなします。1 ページで 30 件まで。
  - 隠した要素には属性を付けず、診断のログも残しません。
- **`example.*`（エンティティ）** — 要素隠し（手続き型を含む）は、ページのホスト名から公開サフィックスを取り除いた前の部分で、実行時に判定します（lib/hosts.js の `entityChain`）。公開サフィックスの一覧は持たず、「最後の 1 ラベル」と、「`co`・`com`・`ne`・`or`・`ac`・`go`・`ed`・`gov`・`edu`・`org`・`net` などに 2 文字の国別コードが続く 2 ラベル（co.jp、com.au、co.uk …）」だけをサフィックスとみなします。`asso.fr` のようなそれ以外の 2 ラベルのサフィックスでは `example.*` が効きません（範囲が広がることはありません）。`~example.*` の除外も同じ判定です。スクリプレットは match pattern にワイルドカードがないため、lib/entity-tlds.js の `SCRIPTLET_ENTITY_TLDS`（25 個）に展開して登録します。展開した数を増やすと登録に時間がかかるため（約 1,560 個の `example.*` で、展開なし 4.6 秒 → 25 TLD で 11 秒 → 48 TLD で 34 秒）、リストのスクリプレットが載せているサイトで多い TLD に絞っています。
- スクリプレットの表はサイトごとに 16 個のファイルに分けてあり（`rules/scriptlets/`）、ページには自分のサイトの分だけが入ります。表はページのスクリプトより先に読み込まれて消えるので、ページからは見えません。
- **拡張機能のエラー画面（chrome://extensions → ADBAN の「エラー」）** — 「Uncaught (in promise) TypeError: Failed to fetch」のようなエラーが `content/scriptlets.js` のものとして並ぶことがありますが、これは**ページ自身の fetch が失敗した**（広告の通信を止めた・オフライン・CORS など）のを、ページが catch していないために出る記録で、ADBAN の不具合ではありません。スクリプレットは fetch などを Proxy で包むので、失敗した fetch の例外の stack の先頭が拡張機能のファイルになり、Chrome が「この拡張機能のエラー」として記録していました（Chrome は stack の先頭のフレームの URL が `chrome-extension://` のときだけ、その拡張機能のエラーにします）。ページ側（MAIN world）で動く `content/scriptlets.js` と `content/yt-main.js` は、ファイルの最後の `//# sourceURL=` でフレームの名前を拡張機能の URL でないものにしてあり、ページの fetch の失敗は記録されません（ページから見た振る舞い・Promise の順序は変わりません）。この行は消さないでください（`tools/main-world-source-url.test.mjs` が確かめます）。代わりに、ADBAN 自身のこれらのファイルの例外もエラー画面には出なくなるので、不具合を調べるときはページの DevTools のコンソール（`adban-scriptlets.js`）を見ます。エラー画面の内容は `node tools/e2e/errors-check.mjs [--sites <json>] [--only <語,語>] [--limit N] [--ext <拡張機能のコピー>]` で集計できます（開いたサイトの ADBAN のエラーを、ページ側の fetch の失敗と ADBAN 自身のものに分けて数えます）。ページから見た振る舞いの比較と件数の確認は `node tools/e2e/fetch-error-test.mjs [--ext <dir>]` です。
- **ページから見えない（見つかりにくい）ようにしてあること** — 広告ブロッカー検出は、組み込み関数の見た目や DOM の痕跡を調べます。スクリプレットが包んだ関数（fetch・JSON.parse・setTimeout など）は、`Function.prototype.toString` も包んで元の関数の文字列に戻すので、`fetch.toString()` や `Function.prototype.toString.call(fetch)` は拡張機能なしと同じ `function fetch() { [native code] }` になります（`Function.prototype.toString.toString()` も同様）。`XMLHttpRequest` はクラスを差し替えず、プロトタイプのメソッド・ゲッターだけを包むので、`instanceof`・`prototype`・descriptor・引数の数の検査が元のままです。兄弟セレクター（`+`・`~`）の評価で一時的に付ける目印の属性の名前、要素の選択（picker）の要素の名前、スクリプレットが投げる例外の文字列は、ページごとの乱数で、拡張機能の名前を含みません。残るもの: 包んだ関数が呼ばれた経路の stack に `at Object.apply (inline-0.js:…)` のフレームが出る（Promise の順序を変えずに消す方法がない）、偽物のリソースへの置き換え後の `fetch` の `response.url` が `chrome-extension://` になる、`set-constant` などがグローバルを getter に変える、など。拡張機能あり・なしの差は `node tools/e2e/stealth-test.mjs` で数えられます（差のある項目が少ないほど見つかりにくい）。
- 偽物への差し替えは、ブロックより強く、例外（`@@`）より弱い優先度にしてあるので、リストの例外はそのまま守られます。Peter Lowe's のようなドメイン丸ごとのブロック（`||googlesyndication.com^` など）が入っていても、差し替えのほうが強いので負けません。
- AdGuard DNS フィルターは DNS 全体向けのホスト名の一覧（約 18 万ホスト）です。ホスト名だけのルールは `requestDomains` に 1,000 件ずつまとめるので、約 880 ルールで済みます。DNS 専用の書き方（IP アドレスの正規表現など）は一部が使えず読み飛ばします。このリストの例外（`@@`）は優先度が高いので、ほかのリストのブロックを同じホストについて打ち消すことがあります（クリック計測のリンクなど、DNS で止めると壊れるものを通すためのものです）。
- リストを足すときは、tools/build-filters.mjs の `LISTS` と manifest.json の `rule_resources` に、同じ ID・順番で書きます（`node tools/check.mjs` が一致を確かめます）。静的ルールは全体で 28,000 件まで（Chrome が保証するのは 30,000 件）、正規表現のルールは 1,000 件までにします。上限を超えたときは前のリストから有効になるので、重要なものほど前に置きます。

## 公開用パッケージを作る

Chrome ウェブストアと Microsoft Edge アドオンには、同じ zip を出します。開発用のフォルダー（このフォルダー）はそのままでは配れない（`tools/e2e/out` の計測結果、テスト、開発用の自動更新、ライセンスの記載がないリストなどが混ざる）ので、許可リスト方式で必要なものだけを集めたパッケージを作ります。

```bash
node tools/make-package.mjs              # dist/package/（展開済み）と dist/adban-<version>.zip
node tools/make-package.mjs --out <dir>  # 出力先を変える
node tools/make-package.mjs --no-zip     # 展開済みのディレクトリだけ
```

- **入れるもの**: `manifest.json`（公開版に変換したもの）、`background.js`、`popup-blocker.js`、`auto-update.js`、`content/`、`lib/`、`options/`、`popup/`、`icons/`、`resources/`、`rules/`（公開版のリストだけ）、`filters/base.txt`（`rules/base.json` の元。GPL v3 で配るので、変換前の元も入れます）、`LICENSE`、`THIRD_PARTY_NOTICES.md`、`README.md`。
- **入れないもの**: `tools/`（計測結果の `tools/e2e/out`、テストを含む）、`dist/`、`_metadata/`（Chrome が作るキャッシュ）、`node_modules`、`.git`、`*.log`、Peter Lowe's list のルール。
- **公開版の `manifest.json`**（開発用の `manifest.json` は変わりません）: `alarms` と `idle` の権限を外す（自動再読み込みは、パソコン側のビルドを使う開発用の仕組みで、ストア版では使えません。`auto-update.js` は権限がなければ何もせず、設定画面の「リストの更新を自動で取り込む」も表示されません）／`peterlowe` をルールセットから外す／`minimum_chrome_version` を 120 にする（`description` は 132 文字以内）。`declarativeNetRequestFeedback` は、ポップアップの「ブロック件数」が `getMatchedRules` を使うため残します。
- 作ったあと、ファイル名に先頭が「_」のものがないこと、`manifest.json` の形、zip を読み戻した内容が展開済みのものと一致すること、`node tools/check.mjs --root dist/package`（ルールと manifest・`rules/meta.json` の対応）を自動で確かめます。
- 公開版のルールは、開発用のフォルダーの `rules/` を元にします。最新のリストを入れたいときは、先に `node tools/build-filters.mjs` を実行してください。ストアの版は、ストアで更新するまで固定です（パソコン側の定期実行による自動更新は、公開版では使えません）。

## ライセンスについての注意

ADBAN は、**GNU General Public License v3**（GPL v3）で公開します。全文は `LICENSE` にあります。

Copyright (C) 2026 ADBAN contributors

`rules/` の中のファイルは、フィルターリストを変換して作ったものです。ADBAN は uBlock Origin（GPL v3）のスクリプレット・偽物のリソースを参考に書き、GPL v3 のリストを変換して同梱しているため、全体を GPL v3 とします。同梱している第三者のもの（各リストの配布元・ライセンス、uBlock Origin 由来のコード、Mozilla 由来の `resources/google-ima.js`（MPL 2.0））は、**`THIRD_PARTY_NOTICES.md`** にまとめてあります。

- **公開版（パッケージ）に入るリスト**（10 種）: ADBAN 基本フィルター（自作）、EasyList・EasyPrivacy（GPL v3 または CC BY-SA 3.0）、AdGuard 日本語フィルター（GPL v3）、uBlock filters・Unbreak・Quick fixes・Badware risks・Privacy（GPL v3）、AdGuard DNS フィルター（リスト自体のヘッダーにライセンスの記載はなく、配布元のリポジトリ https://github.com/AdguardTeam/AdguardSDNSFilter の `LICENSE` が GPL v3）。
- **Peter Lowe's Ad and tracking server list は、公開版に入れません。** リスト自体にライセンスの記載がなく（https://pgl.yoyo.org/adservers/ ）、再配布してよいか確かめられないためです。開発用のフォルダーでは、これまでどおり取得して使えます（個人で使う分には問題ありません）。人に配るときは、公開版のパッケージ（`node tools/make-package.mjs`）を使ってください。
