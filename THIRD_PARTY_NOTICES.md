# 第三者のものについて（THIRD_PARTY_NOTICES）

ADBAN は、Copyright (C) 2026 ADBAN contributors が、GNU General Public License v3（GPL v3）で公開しています（全文は同梱の `LICENSE`）。
このファイルは、ADBAN に同梱している第三者のもの（フィルターリスト、uBlock Origin 由来のコードと偽物のリソース、Mozilla 由来のスクリプト）の出どころとライセンスを示します。
ADBAN はこれらの作者・団体とは無関係で、公認や推薦を受けたものではありません。

## 1. フィルターリスト（`rules/` に変換して同梱）

次のリストを取得し、ブラウザーが読む形（`rules/<id>.json`・`rules/<id>.cosmetic.json`・`rules/<id>.scriptlets.json`・`rules/scriptlets/`・`rules/popups.json`）に変換して入れています。変換のしくみは `tools/build-filters.mjs`（ADBAN のソースコードに含まれ、このパッケージには入りません）と `lib/filters.js` です。リストの本文そのものではなく、ルール（通信の遮断）・要素隠し・スクリプレットの呼び出し・`$popup` を取り出したデータです。変換できない書き方の行は含まれません。各リストの件数と取得日は `rules/meta.json` にあります。

| 名前 | 配布元 | ライセンス | 使い方 |
| --- | --- | --- | --- |
| ADBAN 基本フィルター | `filters/base.txt`（ADBAN 自身が書いたもの） | GPL v3（ADBAN と同じ） | `rules/base.json`・`rules/base.cosmetic.json` に変換 |
| EasyList | https://easylist.to/easylist/easylist.txt | GPL v3 または CC BY-SA 3.0（選択。https://easylist.to/pages/licence.html） | `rules/easylist*.json` に変換 |
| EasyPrivacy | https://easylist.to/easylist/easyprivacy.txt | GPL v3 または CC BY-SA 3.0（選択。https://easylist.to/pages/licence.html） | `rules/easyprivacy*.json` に変換 |
| AdGuard 日本語フィルター | https://filters.adtidy.org/extension/ublock/filters/7.txt（ホームページ: https://github.com/AdguardTeam/AdGuardFilters） | GPL v3（リストのヘッダーの `License:` は https://github.com/AdguardTeam/AdguardFilters/blob/master/LICENSE を指す） | `rules/japanese*.json` に変換 |
| uBlock filters | https://ublockorigin.github.io/uAssetsCDN/filters/filters.min.txt（元: https://github.com/uBlockOrigin/uAssets） | GPL v3（ヘッダーの `License:` は https://github.com/uBlockOrigin/uAssets/blob/master/LICENSE を指す） | `rules/ubo*.json` に変換 |
| uBlock filters – Unbreak | https://ublockorigin.github.io/uAssetsCDN/filters/unbreak.min.txt | GPL v3（同上） | `rules/unbreak*.json` に変換 |
| uBlock filters – Quick fixes | https://ublockorigin.github.io/uAssetsCDN/filters/quick-fixes.min.txt | GPL v3（同上） | `rules/quickfixes*.json` に変換 |
| uBlock filters – Badware risks | https://ublockorigin.github.io/uAssetsCDN/filters/badware.min.txt | GPL v3（同上） | `rules/badware*.json` に変換 |
| uBlock filters – Privacy | https://ublockorigin.github.io/uAssetsCDN/filters/privacy.min.txt | GPL v3（同上） | `rules/privacy*.json` に変換 |
| AdGuard DNS フィルター | https://adguardteam.github.io/HostlistsRegistry/assets/filter_1.txt（ホームページ: https://github.com/AdguardTeam/AdguardSDNSFilter） | GPL v3（**要確認の注記あり**。下の注を参照） | `rules/adguarddns*.json` に変換（ホスト名のブロックだけ。例外 `@@` は取り込まない） |

注（AdGuard DNS フィルター）: このリストのヘッダーには、ライセンスの記載がありません（`Title`・`Description`・`Version`・`Homepage`・`Last modified` だけ）。配布元のリポジトリ https://github.com/AdguardTeam/AdguardSDNSFilter の `LICENSE` ファイルは GNU GPL v3 の全文です（2026-11-11 に確かめました）。リスト自体の記載ではなくリポジトリのライセンスを根拠にしているので、この点は確認が必要なものとして扱ってください。

注（EasyList / EasyPrivacy）: 2 つのライセンスから選べるうち、ADBAN は GPL v3 を選んで、ADBAN 全体を GPL v3 で配っています。

### 同梱していないもの

- **Peter Lowe's Ad and tracking server list**（https://pgl.yoyo.org/adservers/）— リストにライセンスの記載がなく、再配布してよいか確かめられないため、公開版には入れていません（開発用のソースコードの側では取得できます）。

## 2. uBlock Origin 由来のコードと偽物のリソース

uBlock Origin（Raymond Hill ほか。https://github.com/gorhill/uBlock 。GPL v3）のフィルター構文と動作を参考に、ADBAN の中で書いたものです。

| ファイル | 内容 | ライセンス |
| --- | --- | --- |
| `content/scriptlets.js` | スクリプレット（`example.com##+js(名前, 引数…)`）の本体。名前と引数の意味を uBlock Origin に合わせ、同じフィルターで同じ動きになるよう、同名の処理を参考にして書いた | GPL v3 |
| `resources/*.js`（`google-ima.js` 以外）・`resources/*.{gif,png,mp3,mp4,xml,css,html,json,txt}` | `$redirect` で差し替える、何もしない偽物（広告スクリプト、検出ライブラリ、透明な画像、空の VAST など）。`fingerprint2.js`・`hd-main.js`・`nobab2.js` などは uBlock Origin の同名のリソースに合わせて書いた。名前の対応は `lib/resources.js` | GPL v3 |
| `lib/filters.js`・`lib/resources.js`・`lib/entity-tlds.js` | フィルターの変換。uBlock Origin / uBlock filters の書き方（スクリプレット名、`$redirect` の名前など）に合わせてある | GPL v3 |

## 3. Mozilla 由来のスクリプト

| ファイル | 元 | ライセンス | 使い方 |
| --- | --- | --- | --- |
| `resources/google-ima.js` | Mozilla の webcompat の shim（https://searchfox.org/mozilla-central/rev/d317e93d9a59c9e4c06ada85fbff9f6a1ceaaad1/browser/extensions/webcompat/shims/google-ima.js）を、uBlock Origin が改変したもの | MPL 2.0（https://www.mozilla.org/MPL/2.0/）。uBlock Origin 経由の改変部分は GPL v3 | `imasdk.googleapis.com/js/sdkloader/ima3.js` の代わりに差し替える偽物（広告は「なし」として扱わせる）。**ファイルの先頭の出どころ・改変点の表記は、そのまま残してあります（消さないでください）** |

このファイルは MPL 2.0 の対象で、ADBAN 全体（GPL v3）の中にあっても、このファイル自体は MPL 2.0 の条件（ソースの公開など）に従います。MPL 2.0 は、GPL v3 との組み合わせを認めています（MPL 2.0 の 3.3 項）。

## 4. 商標

EasyList、AdGuard、uBlock Origin、Mozilla、Google、Amazon、YouTube などの名前は、それぞれの権利者のものです。ADBAN は、これらの名前を、互換性や出どころを示すためだけに使っています。

## ソースコード

ADBAN のソースコード（`tools/` のビルド・テスト・計測ツールを含む）は、ADBAN の配布元（拡張機能のストアのページに載せるリポジトリ）で公開します。この拡張機能のパッケージの中身（`rules/` を除く JavaScript・HTML・CSS・`filters/base.txt`）は、すでにソースコードのままの形です。`rules/` は上の変換で作ったデータです。
