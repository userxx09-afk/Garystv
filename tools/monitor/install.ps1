# Installs the GarysTV network monitor as a scheduled task (run as Administrator).
# Runs as SYSTEM at startup and every minute; no sign-in needed.
$Dir = 'C:\ProgramData\GarysTV-monitor'
New-Item -ItemType Directory -Force $Dir | Out-Null
if ($PSScriptRoot -ne $Dir) { Copy-Item (Join-Path $PSScriptRoot 'monitor.ps1') $Dir -Force }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Dir\monitor.ps1`""
$t1 = New-ScheduledTaskTrigger -AtStartup
$t2 = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'GarysTV Network Monitor' -Action $action -Trigger $t1,$t2 `
    -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName 'GarysTV Network Monitor'
"Installed. Logging to $Dir\log.csv"
