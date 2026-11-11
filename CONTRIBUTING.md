# 開発に参加するには

ADBAN への貢献（不具合の修正、フィルターの追加、文書の改善）を歓迎します。小さな修正でも構いません。

不具合の報告・ご意見だけなら、コードを書く必要はありません。[SUPPORT.md](SUPPORT.md) をご覧ください。

## 提供のしかた（ライセンス）

ADBAN は **GNU General Public License v3**（GPL v3）で提供されています。プルリクエストを送ると、あなたの変更も GPL v3 で提供されることに同意したものとして扱います。自分で書いたものだけを送ってください。他のプロジェクトのコードを入れるときは、そのライセンスが GPL v3 と両立すること、`THIRD_PARTY_NOTICES.md` に記載する必要があるかどうかを、プルリクエストに書いてください。

## 開発の始め方

必要なもの: Node.js 24（外部の npm パッケージは使いません。`npm install` は不要です）。

```bash
git clone https://github.com/matsuokamatsuo1919-lang/adban.git
cd adban
```

ブラウザーで試すには、Chrome で `chrome://extensions`（Edge なら `edge://extensions`）を開き、デベロッパー モードをオンにして、「パッケージ化されていない拡張機能を読み込む」でこのフォルダーを選びます。

よく使うコマンド:

```bash
node tools/build-filters.mjs          # フィルターリストを取得して rules/ を作り直す（ネットワークが必要。--offline なら filters/base.txt だけ）
node --test "tools/*.test.mjs"        # テスト
node tools/check.mjs                  # 生成したルールが Chrome に受け付けられる形かの点検
node tools/e2e/run.mjs --quick        # 拡張機能を入れた Chrome で、代表的なサイトの広告の残り方・壊れを測る（約 3 分。Chrome が必要）
```

計測ツールの詳しい使い方は [tools/e2e/README.md](tools/e2e/README.md)、全体のしくみは [README.md](README.md) の「しくみ」の節にあります。

## 変更の方針

- **フィルターリストを直接編集しない。** `rules/` は `tools/build-filters.mjs` が作る生成物です。手で書き換えても、次のビルドで消えます。同梱の基本フィルターを直したいときは `filters/base.txt` を編集して、`node tools/build-filters.mjs --offline` で変換します。プルリクエストには、生成された `rules/` の差分は含めなくて構いません（含める場合は、別のコミットにしてください）。
- **誤爆（普通のページが壊れること）を避ける。** 広告を 1 つ消すために、ほかのページのレイアウトやログイン・決済・動画の再生を壊すのは避けたいことです。広い範囲に当たるフィルター（ドメイン丸ごとのブロック、`*` で始まる要素隠しなど）は、当たるサイトの例と、壊れないことの確認方法を書いてください。迷うときは、サイトを限定する書き方（`example.com##.ad`）にします。
- **挙動を変えるときはテストを足す。** `tools/*.test.mjs` に、変更の前に失敗し、後に通るテストを書いてください。
- **プライバシー**: 拡張機能自身が外部へ通信する処理は入れません（`store/` のプライバシーポリシーの前提です）。利用者の情報を集める機能も入れません。
- 既存の書き方（命名、コメントの量、日本語のコメント）に合わせてください。

### `filters/base.txt` の書き方

Adblock Plus 形式です。1 行に 1 つのフィルターを書き、`!` で始まる行はコメントです。

```
! ===== 広告配信 =====
||ads.example.com^                  通信を止める（ドメインと、その下のすべて）
example.com##.ad-banner            example.com の .ad-banner を隠す
@@||cdn.example.com/lib.js         例外（止めない）
```

詳しい書き方は、Adblock Plus のフィルターの書式を参照してください。使えない書き方の行は、変換のときに除かれます。

## プルリクエストの書き方

- 1 つのプルリクエストでは、1 つのことだけをします。
- 「何が問題で、どう直したか」「どう確かめたか（実行したコマンドと結果）」を書いてください。広告やページの表示に関わる変更は、対象のサイトの例（ドメイン）も書いてください。
- 送る前に、`node --test "tools/*.test.mjs"` と `node tools/check.mjs` が通ることを確かめてください。
- 個人情報（名前・メールアドレス・パスワード・閲覧履歴など）を、コードにも説明にも入れないでください。

---

## Summary (English)

- **License**: ADBAN is provided under GPL v3. By sending a pull request, you agree that your changes are provided under GPL v3. Only submit code you wrote, or code whose license is compatible (and say so in the PR).
- **Setup**: Node.js 24, no npm dependencies. Load the folder as an unpacked extension in Chrome or Edge.
- **Commands**: `node tools/build-filters.mjs` (regenerate `rules/`; use `--offline` for `filters/base.txt` only), `node --test "tools/*.test.mjs"`, `node tools/check.mjs`, `node tools/e2e/run.mjs --quick` (needs Chrome).
- **Policy**: Do not edit `rules/` by hand (it is generated; edit `filters/base.txt` instead). Avoid false positives that break normal pages; scope broad rules to specific sites. Add tests for behavior changes. Do not add network requests made by the extension itself or any data collection.
- **Pull requests**: One topic per PR; describe the problem, the fix, and how you verified it (commands and results). Do not include personal information.
