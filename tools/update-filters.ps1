# フィルターリストを更新する（node tools/build-filters.mjs を実行し、結果を tools/update-filters.log に追記する）。
# タスク スケジューラから定期実行する想定（tools/register-update-task.ps1）。手で実行してもよい。
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\update-filters.ps1
# 更新があると rules/meta.json が変わり、ADBAN が（ブラウザーを 60 秒以上操作していないときに）自動で読み込み直す。

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$logPath = Join-Path $PSScriptRoot 'update-filters.log'
$maxLogBytes = 200KB

function Write-Log([string]$text) {
    $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
    foreach ($line in ($text -split "`r?`n")) {
        if ($line.Length -gt 0) { Add-Content -Path $logPath -Value "$stamp $line" -Encoding UTF8 }
    }
}

# ログが 200KB を超えたら、古い半分を捨てる
function Trim-Log {
    if (-not (Test-Path $logPath)) { return }
    if ((Get-Item $logPath).Length -le $maxLogBytes) { return }
    $lines = @(Get-Content -Path $logPath -Encoding UTF8)
    $keep = $lines[([int]($lines.Count / 2))..($lines.Count - 1)]
    Set-Content -Path $logPath -Value $keep -Encoding UTF8
}

function Find-Node {
    $command = Get-Command node -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $candidates = @(
        (Join-Path $env:ProgramFiles 'nodejs\node.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\nodejs\node.exe'),
        (Join-Path $env:NVM_SYMLINK 'node.exe')
    )
    foreach ($path in $candidates) {
        if ($path -and (Test-Path $path)) { return $path }
    }
    return $null
}

try {
    Trim-Log
    Set-Location -Path $root
    Write-Log '--- フィルター更新を開始 ---'

    $node = Find-Node
    if (-not $node) {
        Write-Log 'エラー: Node.js が見つかりません。https://nodejs.org/ から Node.js をインストールして、もう一度実行してください。'
        exit 2
    }

    $outFile = [System.IO.Path]::GetTempFileName()
    $errFile = [System.IO.Path]::GetTempFileName()
    try {
        $process = Start-Process -FilePath $node -ArgumentList 'tools\build-filters.mjs' -WorkingDirectory $root `
            -NoNewWindow -Wait -PassThru -RedirectStandardOutput $outFile -RedirectStandardError $errFile
        $out = Get-Content -Path $outFile -Raw -Encoding UTF8
        $err = Get-Content -Path $errFile -Raw -Encoding UTF8
        if ($out) { Write-Log $out }
        if ($err) { Write-Log "[エラー出力] $err" }
        $code = $process.ExitCode
    } finally {
        Remove-Item -Path $outFile, $errFile -ErrorAction SilentlyContinue
    }

    if ($code -eq 0) {
        Write-Log '--- 完了 ---'
    } else {
        Write-Log "--- 終了コード $code（一部のリストを取得できなかった可能性があります。取得できたリストは更新されています） ---"
    }
    exit $code
} catch {
    Write-Log "エラー: $($_.Exception.Message)"
    exit 1
}
