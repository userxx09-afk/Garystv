# GarysTV network monitor
# Runs once per call (scheduled task: at startup + every minute, as SYSTEM).
# Appends one row to log.csv and new System events to events.csv.
# Repo location: tools/monitor/monitor.ps1

$ErrorActionPreference = 'SilentlyContinue'
$Dir       = 'C:\ProgramData\GarysTV-monitor'
$Log       = Join-Path $Dir 'log.csv'
$EventsLog = Join-Path $Dir 'events.csv'
$StateFile = Join-Path $Dir 'state.json'
$LanIp     = '192.168.254.5'
$VpnIp     = '100.64.0.8'
$Port      = 5480
$Subnet    = '192.168.254.'
$MaxBytes  = 5MB
$Keep      = 5

New-Item -ItemType Directory -Force $Dir | Out-Null

function Rotate-File($path) {
    if ((Test-Path $path) -and ((Get-Item $path).Length -gt $MaxBytes)) {
        $base = [IO.Path]::ChangeExtension($path, $null).TrimEnd('.')
        Remove-Item "$base.$Keep.csv" -Force
        for ($i = $Keep - 1; $i -ge 1; $i--) {
            if (Test-Path "$base.$i.csv") { Rename-Item "$base.$i.csv" "$base.$($i+1).csv" }
        }
        Rename-Item $path "$base.1.csv"
    }
}

function Test-Http($ip) {
    # Returns "200 12ms", "tcp-ok-no-http", "refused/timeout", etc.
    $sw = [Diagnostics.Stopwatch]::StartNew()
    try {
        $req = [Net.HttpWebRequest]::Create("http://${ip}:$Port/")
        $req.Timeout = 3000; $req.ReadWriteTimeout = 3000; $req.Proxy = $null
        $resp = $req.GetResponse(); $code = [int]$resp.StatusCode; $resp.Close()
        return "$code $($sw.ElapsedMilliseconds)ms"
    } catch [Net.WebException] {
        if ($_.Exception.Response) { return "$([int]$_.Exception.Response.StatusCode) $($sw.ElapsedMilliseconds)ms" }
        return "FAIL:$($_.Exception.Status)"
    } catch { return "FAIL:$($_.Exception.GetType().Name)" }
}

Rotate-File $Log
Rotate-File $EventsLog

$now = Get-Date

# --- Wi-Fi ---
$w = @{}
(netsh wlan show interfaces) | ForEach-Object {
    if ($_ -match '^\s*([^:]+?)\s*:\s*(.*)$') { if (-not $w.ContainsKey($matches[1])) { $w[$matches[1]] = $matches[2].Trim() } }
}
$wifiState = $w['State']; $ssid = $w['SSID']; $bssid = $w['AP BSSID']; if (-not $bssid) { $bssid = $w['BSSID'] }
$signal = $w['Signal']; $channel = $w['Channel']; $rx = $w['Receive rate (Mbps)']
# netsh needs Windows Location permission on Win11 24H2+; fall back to adapter info
$ad = Get-NetAdapter -Name 'Wi-Fi'
if (-not $wifiState -and $ad) { $wifiState = "$($ad.Status)/$($ad.MediaConnectionState)"; $rx = $ad.LinkSpeed }
if (-not $ssid) { $ssid = (Get-NetConnectionProfile -InterfaceAlias 'Wi-Fi').Name }
if (-not $signal) { $signal = 'n/a(location off)' }

# --- IP / profile / firewall ---
$ips = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
        ForEach-Object { "$($_.InterfaceAlias)=$($_.IPAddress)" }) -join ';'
$lanIpPresent = [bool](Get-NetIPAddress -IPAddress $LanIp)
$profiles = (Get-NetConnectionProfile | ForEach-Object { "$($_.InterfaceAlias)=$($_.NetworkCategory)/$($_.IPv4Connectivity)" }) -join ';'
$fw = (Get-NetFirewallProfile | ForEach-Object { "$($_.Name)=$(if ($_.Enabled) {'on'} else {'off'})" }) -join ';'
$gw = (Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Sort-Object RouteMetric | Select-Object -First 1).NextHop

# --- Engine ---
$proc = Get-Process -Name GarysTV | Select-Object -First 1
$enginePid = if ($proc) { $proc.Id } else { '' }
$listen = (Get-NetTCPConnection -LocalPort $Port -State Listen | ForEach-Object { $_.LocalAddress }) -join ';'
$est = @(Get-NetTCPConnection -LocalPort $Port -State Established)
$estLan = @($est | Where-Object { $_.RemoteAddress -like "$Subnet*" })
$lanClients = ($estLan | Select-Object -Expand RemoteAddress -Unique) -join ';'
$engineConns = if ($proc) { @(Get-NetTCPConnection -OwningProcess $proc.Id).Count } else { 0 }
$engineMemMB = if ($proc) { [math]::Round($proc.WorkingSet64 / 1MB) } else { '' }
$engineHandles = if ($proc) { $proc.HandleCount } else { '' }

$httpLan = Test-Http $LanIp
$httpVpn = Test-Http $VpnIp
$httpLocal = Test-Http '127.0.0.1'

# --- LAN neighbors (ARP) + ping ---
$neigh = @(Get-NetNeighbor -AddressFamily IPv4 | Where-Object {
    $_.IPAddress -like "$Subnet*" -and $_.IPAddress -ne $LanIp -and $_.IPAddress -notlike '*.255' -and $_.State -ne 'Unreachable' -and $_.LinkLayerAddress -notmatch '^(00-00-00-00-00-00|FF-FF-FF-FF-FF-FF)$'
})
$pingResults = @()
$tasks = @{}
foreach ($n in $neigh) { $p = New-Object Net.NetworkInformation.Ping; $tasks[$n.IPAddress] = $p.SendPingAsync($n.IPAddress, 800) }
foreach ($ip in $tasks.Keys) {
    try { $r = $tasks[$ip].Result; $ok = ($r.Status -eq 'Success') } catch { $ok = $false }
    $pingResults += "$ip=$(if ($ok) {'up'} else {'down'})"
}
$gwPing = if ($gw) { try { (New-Object Net.NetworkInformation.Ping).Send($gw, 1000).Status } catch { 'err' } } else { 'nogw' }

# Every 15 minutes, sweep the whole /24 so new devices land in the ARP table
if ($now.Minute % 15 -eq 0) {
    $sweep = foreach ($i in 1..254) { (New-Object Net.NetworkInformation.Ping).SendPingAsync("$Subnet$i", 500) }
    try { [Threading.Tasks.Task]::WaitAll($sweep) } catch {}
}

# --- New System events since last run ---
$state = if (Test-Path $StateFile) { Get-Content $StateFile -Raw | ConvertFrom-Json } else { $null }
$since = if ($state -and $state.lastEvent) { [datetime]$state.lastEvent } else { $now.AddMinutes(-10) }
$providers = @('Microsoft-Windows-WLAN-AutoConfig','Tcpip','Microsoft-Windows-Tcpip','Microsoft-Windows-Kernel-Power',
               'Microsoft-Windows-Kernel-General','EventLog','Microsoft-Windows-NDIS','Microsoft-Windows-Dhcp-Client',
               'Microsoft-Windows-NlaSvc','Netwtw10','Netwtw14','Netwtw08','Netwtw06','Microsoft-Windows-Windows Firewall With Advanced Security')
$events = @(Get-WinEvent -FilterHashtable @{ LogName = 'System'; StartTime = $since.AddSeconds(1) } -MaxEvents 500 |
    Where-Object { $providers -contains $_.ProviderName -or $_.Level -le 2 })
# Wi-Fi connect/disconnect/roam details live in the WLAN-AutoConfig operational log
$events += @(Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-WLAN-AutoConfig/Operational'; StartTime = $since.AddSeconds(1) } -MaxEvents 200 |
    Where-Object { $_.Id -in 8000,8001,8002,8003,11001,11004,11005,11006,11010,12011,12012,12013,4000,4001,4002,4003,4004,4005,6100 })
$events = @($events | Sort-Object TimeCreated)
foreach ($e in $events) {
    [pscustomobject]@{
        Time = $e.TimeCreated.ToString('yyyy-MM-dd HH:mm:ss'); Provider = $e.ProviderName; Id = $e.Id
        Level = $e.LevelDisplayName; Message = (($e.Message -split "`r?`n")[0..2] -join ' ').Trim()
    } | Export-Csv $EventsLog -Append -NoTypeInformation -Encoding UTF8
}
$lastEvent = if ($events.Count) { $events[-1].TimeCreated } else { $since }
@{ lastEvent = $lastEvent.ToString('o') } | ConvertTo-Json | Set-Content $StateFile -Encoding UTF8
$eventSummary = ($events | Group-Object { "$($_.ProviderName -replace '^Microsoft-Windows-','')#$($_.Id)" } |
    ForEach-Object { "$($_.Name)x$($_.Count)" }) -join ';'

$lastBoot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime

# --- Write row ---
[pscustomobject]@{
    Time          = $now.ToString('yyyy-MM-dd HH:mm:ss')
    Boot          = $lastBoot.ToString('yyyy-MM-dd HH:mm')
    WifiState     = $wifiState
    SSID          = $ssid
    BSSID         = $bssid
    Signal        = $signal
    Channel       = $channel
    RxMbps        = $rx
    LanIpPresent  = $lanIpPresent
    IPs           = $ips
    Gateway       = $gw
    GatewayPing   = $gwPing
    Profiles      = $profiles
    Firewall      = $fw
    EnginePid     = $enginePid
    EngineMemMB   = $engineMemMB
    EngineHandles = $engineHandles
    Listen5480    = $listen
    HttpLan       = $httpLan
    HttpVpn       = $httpVpn
    HttpLocal     = $httpLocal
    EngineConns   = $engineConns
    Est5480       = $est.Count
    Est5480Lan    = $estLan.Count
    LanClients    = $lanClients
    Neighbors     = ($pingResults | Sort-Object) -join ';'
    NewEvents     = $eventSummary
} | Export-Csv $Log -Append -NoTypeInformation -Encoding UTF8
