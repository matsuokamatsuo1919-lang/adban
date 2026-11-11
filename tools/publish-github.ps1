# ADBAN の公開用リポジトリを、GitHub に公開リポジトリとして作る。
# 既定では何も作らず、予定だけを表示する（安全のため）。実際に公開するときだけ -Yes を付ける。
#   予定の確認: powershell -NoProfile -ExecutionPolicy Bypass -File tools\publish-github.ps1
#   公開する:   powershell -NoProfile -ExecutionPolicy Bypass -File tools\publish-github.ps1 -Yes
# 公開すると、リポジトリは誰でも見られる状態になります（あとから非公開に戻すことはできますが、いったん公開した内容は、複製されている可能性があります）。
#
# やること（-Yes のとき）:
#   1. gh のログイン中のアカウントが -User と同じか確かめる（違えば止まる）
#   2. 公開用の一式（dist\repo）を作り直し、個人情報の点検を通す（通らなければ止まる）
#   3. dist\repo で git のリポジトリを作り、最初のコミットを作る（作者は GitHub の noreply のメールアドレス。実際のメールアドレスは使わない）
#   4. GitHub に公開リポジトリを作って送る
#   5. Issue のラベルを作り、GitHub Pages（main の /docs）とトピックを設定する
#   6. 公開されたページ（Issues のテンプレート選択・サポートページ・プライバシーポリシー）が開けることを確かめる

param(
    [string]$User = 'matsuokamatsuo1919-lang',
    [string]$Repo = 'adban',
    [string]$Description = '広告とトラッカーをブロックする Chrome / Edge 拡張機能（Manifest V3）。GPL v3',
    [switch]$Yes
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$root = Split-Path -Parent $PSScriptRoot
$repoDir = Join-Path $root 'dist\repo'
$slug = "$User/$Repo"
$pagesUrl = "https://$User.github.io/$Repo"

function Fail([string]$message) {
    Write-Host "エラー: $message" -ForegroundColor Red
    exit 1
}
function Step([string]$message) { Write-Host "`n== $message" -ForegroundColor Cyan }
function Check-Exit([string]$what) {
    if ($LASTEXITCODE -ne 0) { Fail "$what に失敗しました（終了コード $LASTEXITCODE）。" }
}

# ---- 前提の確認 ----
foreach ($tool in @('gh', 'git', 'node')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { Fail "$tool が見つかりません。" }
}
Set-Location $root

Step 'GitHub のログイン中のアカウントを確認'
$active = (gh api user --jq .login)
Check-Exit 'gh api user（ログイン中のアカウントの取得。gh auth status で、ログインを確かめてください）'
$active = ([string]$active).Trim()
Write-Host "ログイン中（有効）のアカウント: $active"
if ($active -ne $User) {
    Fail "有効なアカウントが $User ではありません。次を実行してから、もう一度お試しください: gh auth switch --user $User"
}

Step '同じ名前のリポジトリが、すでにないか確認'
$previousPreference = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
gh repo view $slug *> $null
$exists = ($LASTEXITCODE -eq 0)
$ErrorActionPreference = $previousPreference
$global:LASTEXITCODE = 0
if ($exists) { Fail "$slug はすでに存在します。上書きしないため、ここで止めます。" }

Step '公開用の一式（dist\repo）を作り直し、個人情報を点検'
node tools/prepare-repo.mjs
Check-Exit '公開用の一式の作成と個人情報の点検'
if (-not (Test-Path (Join-Path $repoDir 'lib\support.js'))) { Fail 'dist\repo\lib\support.js がありません。' }
if (Select-String -Path (Join-Path $repoDir 'lib\support.js') -Pattern '__(SUPPORT|SOURCE|PRIVACY)_URL__' -Quiet) {
    Fail 'lib\support.js に、置き換えていない URL の目印が残っています。node tools/set-public-urls.mjs --apply を実行してください。'
}
foreach ($must in @('.github\ISSUE_TEMPLATE\ad-remains.yml', 'docs\index.md', 'docs\privacy.md', 'LICENSE', 'SUPPORT.md')) {
    if (-not (Test-Path (Join-Path $repoDir $must))) { Fail "dist\repo\$must がありません。" }
}

$id = (gh api user --jq .id)
Check-Exit 'gh api user（数字の ID）'
$id = ([string]$id).Trim()
$noreply = "$id+$User@users.noreply.github.com"

Step '公開の予定'
Write-Host "  リポジトリ     : https://github.com/$slug （公開）"
Write-Host "  説明           : $Description"
Write-Host "  コミットの作者 : $User <$noreply>"
Write-Host "  サポートページ : $pagesUrl/"
Write-Host "  プライバシー   : $pagesUrl/privacy"
Write-Host "  含めるファイル : dist\repo（store/・dist/・計測結果・_metadata は含まれません）"

if (-not $Yes) {
    Write-Host "`n何も作っていません（予定の表示だけです）。実際に公開するには、-Yes を付けて、もう一度実行してください。" -ForegroundColor Yellow
    exit 0
}

# ---- ここから、実際に公開する ----
Step 'git のリポジトリを作り、最初のコミットを作る'
Push-Location $repoDir
try {
    if (Test-Path '.git') { Fail 'dist\repo に .git がすでにあります。prepare-repo は .git を作らないはずなので、確認してください。' }
    git init -b main
    Check-Exit 'git init'
    git config user.name $User
    git config user.email $noreply
    git config core.quotepath false
    git add -A
    Check-Exit 'git add'

    $message = @"
ADBAN 1.1.0 を公開

広告とトラッカーをブロックする Chrome / Edge 拡張機能（Manifest V3）。
ライセンスは GPL v3。ソースコード・フィルターの生成の道具・テスト・計測の道具を含みます。

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
"@
    $messageFile = Join-Path ([System.IO.Path]::GetTempPath()) ("adban-commit-" + [guid]::NewGuid().ToString('N') + '.txt')
    [System.IO.File]::WriteAllText($messageFile, $message, [System.Text.UTF8Encoding]::new($false))
    try {
        git commit -F $messageFile
        Check-Exit 'git commit'
    } finally {
        Remove-Item $messageFile -ErrorAction SilentlyContinue
    }
    Write-Host '作者の確認:'
    git log -1 --format='  %an <%ae>'

    Step 'GitHub に公開リポジトリを作って送る'
    gh repo create $slug --public --description $Description --source . --remote origin --push
    Check-Exit 'gh repo create'
} finally {
    Pop-Location
}

Step 'Issue のラベルを作る'
$labels = @(
    @('広告が残る', 'd93f0b', '広告ブロックで消えない広告の報告'),
    @('表示が壊れる', 'b60205', 'ページが壊れる・表示がおかしい報告'),
    @('要望', '0e8a16', 'ご意見・ご要望')
)
foreach ($label in $labels) {
    gh label create $label[0] --repo $slug --color $label[1] --description $label[2] --force
    if ($LASTEXITCODE -ne 0) { Write-Host "警告: ラベル「$($label[0])」を作れませんでした。" -ForegroundColor Yellow; $global:LASTEXITCODE = 0 }
}

Step 'GitHub Pages・トピック・リポジトリの設定'
gh api -X POST "repos/$slug/pages" -f 'source[branch]=main' -f 'source[path]=/docs' | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Host '警告: GitHub Pages を有効にできませんでした。Settings > Pages で、Branch: main、Folder: /docs を選んでください。' -ForegroundColor Yellow; $global:LASTEXITCODE = 0 }
gh repo edit $slug --homepage "$pagesUrl/" --add-topic adblock --add-topic ad-blocker --add-topic chrome-extension --add-topic edge-extension --add-topic manifest-v3 --add-topic privacy --enable-wiki=false --enable-projects=false
if ($LASTEXITCODE -ne 0) { Write-Host '警告: リポジトリの設定（トピックなど）を変更できませんでした。' -ForegroundColor Yellow; $global:LASTEXITCODE = 0 }

Step '公開されたページが開けるか確認（GitHub Pages は、公開の 1〜3 分後に表示されます）'
$targets = @(
    "https://github.com/$slug",
    "https://github.com/$slug/issues/new/choose",
    "$pagesUrl/",
    "$pagesUrl/privacy"
)
foreach ($url in $targets) {
    $ok = $false
    for ($i = 0; $i -lt 18 -and -not $ok; $i++) {
        try {
            $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 20
            if ($response.StatusCode -eq 200) { $ok = $true }
        } catch {
            Start-Sleep -Seconds 10
        }
    }
    if ($ok) { Write-Host "  OK   $url" -ForegroundColor Green } else { Write-Host "  未確認 $url （しばらくしてから、ブラウザーで開いてください）" -ForegroundColor Yellow }
}

Write-Host "`n公開しました: https://github.com/$slug" -ForegroundColor Green
Write-Host 'ストアの申請フォームには、次を入れてください:'
Write-Host "  サポート URL         : https://github.com/$slug/issues"
Write-Host "  ホームページ URL     : $pagesUrl/"
Write-Host "  プライバシーポリシー : $pagesUrl/privacy"
