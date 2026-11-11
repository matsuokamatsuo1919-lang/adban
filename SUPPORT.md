# サポート・ご意見

ADBAN の不具合の報告、広告が残るサイトの報告、ご意見・ご要望は、次の窓口で受け付けています。

## 窓口

| 内容 | 送り先 |
| --- | --- |
| 広告が残っている | [Issues（広告が残る）](https://github.com/matsuokamatsuo1919-lang/adban/issues/new?template=ad-remains.yml) |
| ページが壊れた・表示がおかしい | [Issues（表示が壊れる）](https://github.com/matsuokamatsuo1919-lang/adban/issues/new?template=site-broken.yml) |
| ご意見・ご要望 | [Issues（要望）](https://github.com/matsuokamatsuo1919-lang/adban/issues/new?template=feature-request.yml) |
| 上のどれか分からない | [Issues のテンプレート一覧](https://github.com/matsuokamatsuo1919-lang/adban/issues/new/choose) |
| セキュリティ上の問題 | 下の「セキュリティ上の問題」へ |

GitHub のアカウントが必要です。アカウントを作りたくない場合は、メールでも受け付けます（下の連絡先）。

## 拡張機能の「問題を報告」ボタン

ツールバーの ADBAN のアイコンを押すと、ポップアップの下に **問題を報告** があります（設定画面にも同じ入口があります）。

1. 「問題を報告」を押し、種類（広告が残っている／ページが壊れた・表示がおかしい／ご意見・ご要望）を選びます。
2. 報告に役立つ情報（ADBAN の版、ブラウザーの種類と版、OS の名前、設定のオン・オフ、今のサイトのホスト名、止めた件数など）が、クリップボードにコピーされます。コピーされる内容は画面に表示されます。
3. 「サポートのページを開く」を押すと、Issues のフォームが開きます。コピーした内容を貼り付けて、送ります。

**自動では何も送られません。** ADBAN は、報告の内容を開発者や第三者のサーバーに送信しません。貼り付けて送るかどうかは、あなたが決めます。貼り付ける前に、内容を確認・編集できます。

## 書いてはいけないもの

Issues は**誰でも読める公開の場所**です。次のものは書かないでください。

- 名前、メールアドレス、電話番号、住所
- パスワード、認証コード、ログイン用の URL（URL に含まれるトークンなど）
- 閲覧履歴、アカウント名、購入や会員の情報
- ページのスクリーンショットに写った個人情報（写す場合は、隠してください）

サイトの情報は、ドメイン（例: `example.com`）だけで足ります。URL を書くときは、`?` より後ろ（クエリ）を除いてください。

もし書いてしまったときは、Issue の「編集」から消してください。消せないときは、下の連絡先へご連絡ください。

## 返信の目安

数日以内の返信を目標にしていますが、確約はできません（個人で運営しています）。再現できない場合は、追加の質問をすることがあります。広く使われているサイトが壊れる問題を優先し、次に誤って隠してしまう問題、広告の残りの順に対応します。

## セキュリティ上の問題

セキュリティ上の問題（拡張機能が悪用されるおそれのある不具合など）は、公開の Issues には書かず、メールで連絡してください。

- メール: matsuokamatsuo1919@gmail.com

## 関連ページ

- [README](README.md)（できること・できないこと、インストール）
- [CONTRIBUTING.md](CONTRIBUTING.md)（開発に参加するには）
- [プライバシーポリシー](docs/privacy.md)

---

## Summary (English)

- **Where to report**: Use [GitHub Issues](https://github.com/matsuokamatsuo1919-lang/adban/issues/new/choose) for ads that remain, pages that break, and feature requests. A GitHub account is required; if you do not want one, email matsuokamatsuo1919@gmail.com.
- **"Report a problem" button**: In the extension popup (and the settings page), it copies a short report (extension version, browser and OS name, settings, host name of the current site, blocked count) to your clipboard and opens the Issues form. **Nothing is sent automatically.** You review it, paste it, and send it yourself.
- **Do not post personal information**: no names, email addresses, passwords, addresses, browsing history, or account details. Issues are public. A domain name is enough; remove query strings from URLs.
- **Response time**: we aim to reply within a few days, but this is not guaranteed. Widely used sites that break come first, then false positives, then remaining ads.
- **Security issues**: please email matsuokamatsuo1919@gmail.com instead of opening a public issue.
