# GarysTV network monitor (tools/monitor)

Logs once a minute why Fire TVs on the LAN might lose the GarysTV engine (:5480).

- `monitor.ps1` – one sample per run. Writes `C:\ProgramData\GarysTV-monitor\log.csv`
  (Wi-Fi state/SSID/link speed, IPs, gateway ping, network profiles, firewall profiles,
  engine PID/mem/handles, HTTP check of 5480 on LAN/VPN/localhost, connection counts,
  LAN clients on 5480, ARP neighbors + ping, summary of new System events) and
  `events.csv` (full new System + WLAN-AutoConfig events). Files rotate at 5 MB, 5 kept.
  Full /24 ping sweep every 15 minutes to refresh ARP.
- `install.ps1` – run as Administrator once; registers task "GarysTV Network Monitor"
  (SYSTEM, at startup + every minute, no sign-in needed).

Note: Wi-Fi signal/BSSID need Windows Location services on (netsh restriction on
newer Windows 11); without it the log shows adapter status and link speed instead.

When it breaks: note the time, then compare `HttpLan` vs `HttpVpn`, `LanIpPresent`,
`Profiles`, `Est5480Lan`, `Neighbors`, and `events.csv` around that time.
