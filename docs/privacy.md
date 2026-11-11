---
layout: page
title: プライバシーポリシー / Privacy Policy
---

<!-- このファイルは tools/build-docs.mjs が store/privacy-policy.ja.md と store/privacy-policy.en.md から作ります。直接編集しないでください。 -->

- [日本語（プライバシーポリシー）](#ja)
- [English (Privacy Policy)](#en)

<a id="ja"></a>

## ADBAN プライバシーポリシー

最終改定日: 2026-11-11

ADBAN（以下「本拡張機能」）は、ウェブサイトの広告とトラッカーをブロックするブラウザー拡張機能です。このポリシーは、本拡張機能が利用者のデータをどのように扱うかを説明します。

提供者: 松岡
連絡先: matsuokamatsuo1919@gmail.com

### 1. 要約

- 本拡張機能は、利用者の個人情報、閲覧履歴、ページの内容を**収集しません**。
- 本拡張機能は、開発者や第三者のサーバーへ**データを送信しません**。本拡張機能自身がインターネットへ通信する処理はありません（フィルターの取得・送信、利用状況の分析、エラーの報告などをしません）。
- 設定などは、利用者のブラウザーの中（`chrome.storage.local`）にだけ保存されます。アカウント登録は不要です。
- 第三者への提供・販売・広告への利用は**ありません**。

### 2. 収集するデータ

なし。本拡張機能は、データを収集・送信・共有しません。分析ツール、広告、トラッキングの仕組みも入れていません。

### 3. ブラウザーの中に保存するもの

次のものを、利用者のブラウザーの中（`chrome.storage.local`）に保存します。ブラウザーの同期機能では送られず、開発者を含む他者からは見えません。拡張機能を削除すると、これらも削除されます。

| 保存するもの | 内容 | 目的 |
| --- | --- | --- |
| 設定 | 全体のオン・オフ、使うフィルターリストの選択、YouTube の広告データの除去、空の広告枠・記事広告のたたみ込み、Prime Video の診断の記録のオン・オフ | 設定を覚えるため |
| ブロックしないサイト | 利用者が入力した、または「このサイトでブロックする」をオフにしたサイトのドメイン | そのサイトでブロックを止めるため |
| 自分で書いたフィルター | 利用者が設定画面に書いたフィルター、「要素を選んでブロック」で選んだ要素の指定（サイトのドメインと CSS の選択子） | 利用者が指定したものを隠すため |
| 登録状態のメモ | 拡張機能の版とフィルターリストの更新日時などの、内部の登録状態 | 広告ブロッカー対策のスクリプトの登録をやり直さずに済ませるため |
| Prime Video の診断（`pvDiag`） | 下の「Prime Video の診断」を参照 | Prime Video の広告の見つけ方を直す手がかりにするため（既定でオフ。利用者が設定画面でオンにしたときだけ記録する。いつでもオフにでき、記録も消せる） |

また、設定画面に表示するエラーの状態を、ブラウザーを閉じると消える一時的な領域（`chrome.storage.session`）に置くことがあります。

#### Prime Video の診断（`pvDiag`）

Prime Video のページで広告の検出がうまくいかないときの手がかりとして、再生中に広告まわりの画面の部品と動画の状態をこのブラウザーの中に記録できます。**この記録は既定ではオフで、利用者が設定画面の「Prime Video の診断」で自分でオンにしたときだけ行います。**オンにしたあとも、いつでもオフにでき、記録を消せます。

- 保存するもの: 動画の状態（再生位置・速度・ミュート・大きさ）、広告やスキップの語・時刻を含む短い画面部品の名前（タグ・class・`data-testid`・見え方・大きさ・広告の語と時刻だけの文字）、広告検出の結果、広告や再生に関わりそうな通信のホストとパス（クエリは除き、ID らしい部分は伏せます）、ページのパス（ID は伏せます）。
- 保存しないもの: 作品名・タイトル・ページの題名・プレーヤー全体の文字・アカウント情報・通信のクエリや中身。広告の語と数字・記号だけでできていない文字は「[伏せた]」と記録します。
- 件数の上限: 広告かもしれない場面を最大 5 件、再生 60 秒ごとの記録を最大 10 件。
- 診断は**自動では送信されません**。利用者が設定画面の「診断をコピー」を押して、自分の意思で貼り付けて送った場合にだけ、相手に渡ります。

### 4. ページの内容の扱い

広告を隠すため、本拡張機能はウェブページの class や id の名前、要素の見た目や短い文字（「広告」「PR」などの札の判定）を、利用者のブラウザーの中だけで調べます。これらは保存せず（上の診断を除く）、どこにも送信しません。

また、広告のポップアップを閉じるために、新しく開かれたタブの URL を、同梱のフィルターと照らし合わせます。照合はブラウザーの中だけで行い、URL を保存・送信しません。

ポップアップで今のサイトのホスト名を表示します。これも画面に出すだけで、保存・送信しません。

### 5. 外部への送信

- 本拡張機能は、フィルターリストや設定を外部から取得することも、外部へ送信することもしません。フィルターのルールは、拡張機能のパッケージに同梱されており、更新は拡張機能の更新（ストアの配布）で行います。
- フィルターリストの元データの取得と変換は、開発者のパソコンでビルドのときに行われます。利用者のブラウザーでは行われません。
- 外部からコードを取得して実行することもありません。
- 開発用の版には、パソコン側でビルドしたルールの更新を検知して自動で読み込み直す仕組み（`alarms`・`idle` の権限を使う）がありますが、ストアで配布する版には含まれません（権限も要求しません）。
- 本拡張機能は、広告の通信を止めたり、広告の読み込みを「何もしない」同梱の代用品に置き換えたりします。ページ自身が行う通信を、本拡張機能が代わりに送ることはありません。

#### 「問題を報告」（利用者が押したときだけ）

ポップアップと設定画面に、「問題を報告」（設定画面では「意見・不具合の報告」）の入口があります。**利用者が、報告の種類を選んだときだけ**、本拡張機能は次の 2 つを行います。

1. 報告用の情報（下の一覧）を、利用者のクリップボードにコピーする。
2. サポートのページ（外部のサービス。GitHub など）を、新しいタブで開く。開く URL には、報告の種類に応じたテンプレートの名前だけが付き、利用者の情報は付きません。

本拡張機能が、報告の内容を自動で送信することは**ありません**。利用者が、開いたページに自分で貼り付け、内容を確認・編集したうえで、自分の意思で送信した場合にだけ、その内容がサポートのページを運営するサービスに渡ります（設定画面では、コピーされる内容を、押す前に確認できます）。

- コピーされるもの: 拡張機能の版、ブラウザーの名前と版（Chrome / Edge）、OS の名前（Windows / macOS / Linux / ChromeOS / その他）、フィルターリストの更新日と有効なリスト名、設定（全体のオン・オフ、そのサイトでのオン・オフ、YouTube の広告データの除去、空の広告枠・記事広告のたたみ込み、Prime Video の診断のオン・オフ）、ブロックしないサイトの**件数**、自分で書いたフィルターの**行数**、いま開いているタブの**ドメイン名**（ホスト名だけ）とそのタブで止めた件数。そして、利用者が自分で書き足すための空の欄。
- コピーされないもの: ページの URL 全文（パス・クエリ・ハッシュ）、ページのタイトルや内容、閲覧履歴、アカウント情報、ブロックしないサイトや自分で書いたフィルターの中身、Prime Video の診断の記録の中身、userAgent の全文。
- 貼り付けたあとの扱いは、そのサービス（GitHub など）のプライバシーポリシーに従います。開発者は、そこに書かれた内容を、不具合の調査と改善のためにだけ使います。個人情報（名前・メールアドレス・パスワード・住所など）は書かないでください。
- クリップボードへのコピーとタブを開く処理に、追加の権限は要りません。

### 6. 第三者への提供

利用者のデータを、第三者に提供・販売・貸与・譲渡しません。広告・信用調査・融資の判断など、拡張機能の機能と関係のない目的にも使いません。

### 7. 権限について

本拡張機能が要求する権限と、その使い方は次のとおりです。

- ネットワークのルール（`declarativeNetRequest`）: 広告・トラッカーへの通信を止めるため。
- `declarativeNetRequestFeedback`: ポップアップに「このページでブロックした件数」を表示するため。
- `scripting`: 広告を隠す CSS の挿入、広告ブロッカー対策への対策や YouTube の広告データの除去のためのスクリプトの登録（ページ側で動かす必要があるもの）、要素を選ぶ画面の注入のため。いずれも拡張機能に同梱したファイルだけを使います。
- `storage`: 上記の設定を保存するため。
- `webNavigation`: 広告のポップアップ（新しく開かれたタブ）を見つけて閉じるため。
- すべてのサイトへのアクセス（`<all_urls>`）: 広告はどのサイトにも出るので、すべてのページで広告を隠し、広告ブロッカー対策への対策を動かすため。

権限の詳しい理由は、ストアの申請ページにも記載しています。

### 8. 利用者の選択

- 設定画面で、全体や機能ごとにオフにできます。サイトごとのオン・オフもできます。
- Prime Video の診断は既定でオフです。オンにしたときも、設定画面でいつでもオフにでき、「診断を消す」で記録を消せます。
- 拡張機能を削除すると、保存したデータはすべて削除されます。

### 9. 子どものプライバシー

本拡張機能は、個人情報を収集しません。年齢にかかわらず利用できます。

### 10. このポリシーの変更

機能やデータの扱いを変えるときは、このポリシーを先に更新し、改定日を変更します。データの扱いが変わる更新は、ストアの説明にも記載します。

### 11. 連絡先

このポリシーや本拡張機能についてのお問い合わせは、次へお願いします。

- メール: matsuokamatsuo1919@gmail.com
- サポート: 上のメールアドレスまでご連絡ください

---

<a id="en"></a>

## ADBAN Privacy Policy

Last updated: 2026-11-11

ADBAN (the "Extension") is a browser extension that blocks ads and trackers on websites. This policy explains how the Extension handles user data.

Publisher: 松岡
Contact: matsuokamatsuo1919@gmail.com

### 1. Summary

- The Extension does **not collect** your personal information, browsing history, or page content.
- The Extension does **not send data** to the developer or to any third party. The Extension itself makes no network requests to fetch or send anything (no filter downloads, no analytics, no error reporting).
- Settings are stored only inside your browser (`chrome.storage.local`). No account is needed.
- Nothing is sold, shared with third parties, or used for advertising.

### 2. Data we collect

None. The Extension does not collect, transmit, or share any data. It contains no analytics, advertising, or tracking code.

### 3. What is stored in your browser

The Extension stores the following in your browser (`chrome.storage.local`). It is not synced by the browser's sync feature, and nobody else, including the developer, can see it. It is deleted when you remove the Extension.

| Stored item | Content | Purpose |
| --- | --- | --- |
| Settings | Global on/off, which filter lists to use, YouTube ad-data removal, collapsing of empty ad slots and sponsored-article cards, on/off for the Prime Video diagnostics | To remember your choices |
| Sites you do not want blocked | Domains you typed in, or sites for which you turned blocking off in the popup | To stop blocking on those sites |
| Your own filters | Filters you wrote in the settings page, and selectors saved with "Pick an element to block" (a site's domain and a CSS selector) | To hide what you chose |
| Registration state | Internal bookkeeping such as the extension version and the filter lists' update times | To avoid re-registering the anti-adblock-circumvention scripts unnecessarily |
| Prime Video diagnostics (`pvDiag`) | See "Prime Video diagnostics" below | To help fix how Prime Video ads are detected (off by default; records are made only if you turn it on in the settings page, and you can turn it off and delete the records at any time) |

The Extension may also keep error status for the settings page in a temporary area (`chrome.storage.session`) that is cleared when the browser closes.

#### Prime Video diagnostics (`pvDiag`)

When ad detection on Prime Video does not work well, the Extension can record, inside your browser only, the page parts around ads and the state of the video while you watch. **This is off by default and records only if you turn it on yourself in the settings page ("Prime Video diagnostics").** Once on, you can turn it off at any time, and you can delete the records there.

- What is stored: video state (playback position, speed, muted, size); short names of page parts that contain ad or skip wording or a time (tag, class, `data-testid`, visibility, size, and text made up only of ad words and times); the ad-detection result; the host and path of requests that look related to ads or playback (query strings dropped, ID-like parts masked); and the page path (IDs masked).
- What is not stored: titles of works, the page title, text of the whole player, account information, or the query strings and contents of requests. Text that is not made up only of ad words, numbers and symbols is recorded as "[masked]".
- Limits: up to 5 "possible ad" events and up to 10 periodic records (one per 60 seconds of playback).
- Diagnostics are **never sent automatically**. They reach someone only if you press "Copy diagnostics" in the settings page and paste and send them yourself.

### 4. How page content is handled

To hide ads, the Extension examines class and id names, the appearance of elements, and short text (to recognize labels such as "Ad" or "PR") on web pages, entirely inside your browser. This information is not stored (apart from the diagnostics above) and is not sent anywhere.

To close ad popups, the Extension compares the URL of newly opened tabs against the bundled filters. The comparison happens inside your browser; the URL is neither stored nor sent.

The popup shows the host name of the current site. It is only displayed, not stored or sent.

### 5. Network activity

- The Extension does not download filter lists or settings from anywhere, and does not upload anything. Filter rules are bundled in the extension package, and are updated only through extension updates distributed by the store.
- Fetching and converting the original filter lists happens on the developer's computer at build time, not in your browser.
- The Extension does not fetch and run code from outside.
- The development build has a mechanism that detects rules rebuilt on the developer's own computer and reloads automatically (it uses the `alarms` and `idle` permissions). It is not included in the version distributed through the stores, which does not request those permissions.
- The Extension blocks ad requests, and replaces some ad scripts with harmless bundled stand-ins. The Extension never sends the page's own network requests on the page's behalf.

#### "Report a problem" (only when you press it)

The popup and the settings page have a "Report a problem" entry (in the settings page: "Feedback and bug reports"). **Only when you choose a type of report**, the Extension does these two things:

1. It copies a report (listed below) to your clipboard.
2. It opens a support page (an external service, such as GitHub) in a new tab. The URL contains only the name of a template for the type of report you chose, and none of your information.

The Extension does **not** send the contents of a report automatically. They reach the service that runs the support page only if you paste them into the page yourself, review and edit them, and submit them on your own initiative (in the settings page you can read what would be copied before you press anything).

- What is copied: the extension version, the browser name and version (Chrome / Edge), the OS name (Windows / macOS / Linux / ChromeOS / other), the update date and names of the enabled filter lists, settings (global on/off, on/off for the current site, removal of YouTube ad data, folding of empty ad slots and sponsored cards, whether Prime Video diagnostics are on), the **number** of exempted sites, the **number of lines** of your own filters, the **domain name** of the current tab (host name only) and the number of requests blocked on that tab, plus empty sections for you to fill in.
- What is not copied: the full URL of the page (path, query, hash), the page title or content, browsing history, account information, the contents of your exempted sites or your own filters, the contents of the Prime Video diagnostics record, and the full user-agent string.
- What happens to what you paste is governed by the privacy policy of that service (GitHub, etc.). The developer uses it only to investigate and fix problems. Please do not write personal information (name, email address, password, home address, etc.).
- Copying to the clipboard and opening a tab need no additional permission.

### 6. Sharing with third parties

We do not share, sell, rent, or transfer user data to third parties. We do not use it for purposes unrelated to the Extension's functions, such as advertising or credit decisions.

### 7. Permissions

- Network rules (`declarativeNetRequest`): to block requests to ad and tracker servers.
- `declarativeNetRequestFeedback`: to show "requests blocked on this page" in the popup.
- `scripting`: to insert CSS that hides ads, to register the scripts that must run in the page itself (anti-adblock countermeasures, removing ad data on YouTube), and to inject the element picker. Only files bundled in the extension are used.
- `storage`: to save the settings above.
- `webNavigation`: to detect and close ad popups (newly opened tabs).
- Access to all sites (`<all_urls>`): ads appear on any site, so the Extension hides ads and runs its anti-adblock-circumvention measures on all pages.

More detailed reasons are also given on the store submission page.

### 8. Your choices

- You can turn off the whole Extension or individual features in the settings page, and you can turn it off per site.
- Prime Video diagnostics are off by default. If you turn them on, you can turn them off again in the settings page at any time, and the records can be deleted with "Clear diagnostics".
- Removing the Extension deletes all stored data.

### 9. Children's privacy

The Extension collects no personal information, regardless of age.

### 10. Changes to this policy

When features or data handling change, this policy is updated first and its date is revised. Changes affecting data handling are also noted in the store description.

### 11. Contact

For questions about this policy or the Extension:

- Email: matsuokamatsuo1919@gmail.com
- Support: please contact us by email at the address above
