# フィルター更新（tools/update-filters.ps1）を、Windows のタスク スケジューラに登録する。
# 現在のユーザーの権限で登録するので、管理者権限は要りません（ログオン中だけ動きます）。
#   登録:   powershell -NoProfile -ExecutionPolicy Bypass -File tools\register-update-task.ps1
#   時刻:   ... -At 05:00        （毎日の実行時刻。既定は 03:30）
#   削除:   ... -Unregister
# 毎日 1 回と、ログオン時に 1 回（その時刻にパソコンが off だったときの取りこぼし対策。-StartWhenAvailable も有効）実行します。

param(
    [string]$At = '03:30',
    [switch]$Unregister
)

$ErrorActionPreference = 'Stop'
$taskName = 'ADBAN フィルター更新'
$updateScript = Join-Path $PSScriptRoot 'update-filters.ps1'
$root = Split-Path -Parent $PSScriptRoot

if ($Unregister) {
    if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        Write-Host "タスク「$taskName」を削除しました。"
    } else {
        Write-Host "タスク「$taskName」は登録されていません。"
    }
    exit 0
}

if ($At -notmatch '^\d{1,2}:\d{2}$') {
    Write-Error "-At は 03:30 のような 時:分 の形で指定してください（指定: $At）"
    exit 1
}
if (-not (Test-Path $updateScript)) {
    Write-Error "$updateScript が見つかりません。"
    exit 1
}

$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -WorkingDirectory $root `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$updateScript`""
$daily = New-ScheduledTaskTrigger -Daily -At ([datetime]$At)
$logon = New-ScheduledTaskTrigger -AtLogOn -User $user
$logon.Delay = 'PT2M' # ログオン直後はネットワークがつながっていないことがあるので、2 分待つ
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($daily, $logon) -Settings $settings -Principal $principal `
    -Description 'ADBAN のフィルターリストを更新します（tools/update-filters.ps1）。' -Force | Out-Null
Write-Host "タスク「$taskName」を登録しました（毎日 $At とログオン時）。ログ: $(Join-Path $PSScriptRoot 'update-filters.log')"
Write-Host '今すぐ試すには: Start-ScheduledTask -TaskName "ADBAN フィルター更新"'
