# GarysTV

A Windows DVR for over-the-air TV (antenna) and IPTV, with a DISH-style guide built for a TV remote or keyboard.

## Run it

```
npm install
npm start          # normal
npm run demo       # adds practice channels + a made-up guide (no tuner needed)
npm test           # parser / matching / scheduler tests
npm run dist       # build a Windows installer (dist/)
```

Several channels can record at once: up to 6 Free TV channels, as many as an HDHomeRun has tuners, and an IPTV provider's stream limit.

**Live TV pause & rewind:** while you watch a channel, GarysTV keeps the last 30 minutes of it (Settings > Recording > Watching) in a `.live-buffer` folder inside the recordings folder, so you can pause, rewind and jump back to live. Changing channel starts a fresh buffer. It uses about 1 GB of disk for 30 minutes, and is shortened automatically when the disk is nearly full. If the stream drops, the buffer carries on when it comes back.

**Commercial skip:** after a recording finishes, GarysTV looks for commercial breaks (the short black, silent gaps broadcasters put around ads) and skips them during playback, or offers to (Settings). It works best on antenna recordings; internet channels often insert ads without those gaps.

Closing the window asks whether to exit GarysTV or keep it running in the system tray so timers still record (Settings > Recording can remember the answer). The tray menu's **Exit GarysTV** also closes it; exiting stops recordings and lets them finish writing. While a recording runs, the PC won't go to sleep.

## Hardware & helpers

| Need | Recommended | Why |
|---|---|---|
| Antenna tuner | **HDHomeRun** (Flex 4K, Connect Duo/Quatro) | A network tuner; Windows needs no drivers. GarysTV finds it automatically. |
| Recording storage | Any internal or USB drive, or a NAS | Settings > Recording > *Save recordings on*: a folder on this computer, or **network storage** (a NAS or shared folder: SMB, or NFS on the home server). About 3–7 GB per hour of HD over-the-air TV. With network storage, live TV's rewind buffer stays on this computer, and a recording that starts while the NAS isn't answering is saved on this computer instead. On Windows the share's password goes to Windows' Credential Manager; on the home server a root helper (`install/nas-linux.sh`) mounts the share at `/mnt/garystvnas` and keeps the password in `/etc/garystv/nas-credentials` (root only). |
| Watching | **ffmpeg** (built-in player), **VLC** (backup player) | OTA TV is MPEG-2, which needs converting to play in-app. On Windows, GarysTV installs both when they are missing (VLC asks Windows for permission once), or use Settings > Status. The home-server installer adds ffmpeg. On a Fire TV or Android phone, the VLC app is the backup player (hold OK while watching > Play in VLC). |

USB stick tuners (Hauppauge etc.) aren't supported yet. They need a different, driver-based capture path.

## Free TV (on by default)

GarysTV starts with about 140 free channels streamed over the internet, numbered like a DISH lineup:

| Numbers | What |
|---|---|
| 101+ | Iowa & Midwest locals: KAAL ABC 6 (Mason City), plus Minneapolis, Chicago and Milwaukee ABC/NBC/FOX stations (mostly their local news) |
| 201+ | News: NBC News NOW, LiveNOW from FOX, Scripps News, Reuters, USA TODAY and more |
| 251+ | Weather: The Weather Channel, Fox Weather, AccuWeather, WeatherNation |
| 301+ | Sports & outdoors: NBC Sports NOW, NHL Network, Tennis Channel, Outdoor Channel and more |
| 401+ | Movies: Hallmark Movies & More, MovieSphere, westerns and classics |
| 501+ | Entertainment: Johnny Carson, SNL Vault, Survivor, AFV, This Old House, mysteries, game shows |
| 601+ | Kids & family: PBS Kids and more |
| 701+ | PBS, documentaries, cooking and lifestyle |
| 801+ | Music |

These come from [iptv-org](https://github.com/iptv-org/iptv), limited to streams served by the channel's owner or a licensed free service (Tubi, Xumo, Stirr, Samsung TV Plus and similar). They're ad-supported and have no schedule listings. GarysTV re-checks them at startup and daily and hides any that are off the air. Remove or hide them in Settings like any other source.

**Full ABC/CBS/NBC/FOX programming** (primetime, sports, local shows) isn't available as a free internet stream. Get it with an antenna and an HDHomeRun.

To refresh the lineup from iptv-org (re-tests every stream; takes a few minutes): `npm run free-channels`.

## Guide data

* **HDHomeRun built-in guide**: added automatically. Free, but covers only the next several hours.
* **XMLTV** (Settings > Guide data): a file or URL. For 1–2 weeks of listings, use Schedules Direct (about $35/yr) with an XMLTV grabber.
* **IPTV**: if the playlist includes a guide link (`url-tvg`), it's added automatically.

Settings > **Channels & matching** shows how each tuner channel was matched to a guide listing (by number, call sign, name). Fix any match marked *Likely*/*Check*, and hide channels you never watch.

## Remote / keyboard

| Key | Action |
|---|---|
| Arrows, Enter, Esc | Move, select, back |
| G / D / T / S / H | Guide, My Recordings, Timers, Search, Home |
| R (in guide) | Record show → press again for the series → again to cancel |
| 0–9 (in guide) | Jump to channel |
| PgUp/PgDn, `[` `]` | Page channels, jump a day |
| Watching live TV | ← back 10s, → ahead 30s, Space pause, L (or fast-forward to the end) back to live, ↑↓ change channel, G (or Back) guide with picture-in-picture; in the guide, OK on the picture watches again and Back goes Home |
| Watching a recording | ← back 10s, → skip 30s, Space pause, OK skips a commercial break |
| R while watching | Record Now: this show, 30 min to 3 hours, or until you stop it (press R again to stop) |
| F11 | Full screen |

## How it's built

```
main.js                 Windows shell (window, tray, no-sleep while recording)
src/core/               the DVR engine (plain Node, no Electron dependency)
  sources/              hdhomerun.js, m3u.js, demo.js   <- add new providers here
  guide/                xmltv.js, hdhomerun-guide.js, reconcile.js (channel matching)
  scheduler.js          timers -> upcoming recordings, duplicate & tuner-conflict handling
  recorder.js           stream -> .ts file, auto-reconnect on signal loss
  timeshift.js          live TV pause/rewind buffer (the last 30 minutes of the channel being watched)
  commercials.js        finds commercial breaks in finished recordings
  sports.js             My Teams: schedules (ESPN) matched to channels
  diagnostics.js        playback health: why live TV stuttered (the channel, this PC, the network, or GarysTV)
  server.js             HTTP API + video stream + serves the screens
src/ui/                 the screens (plain HTML/CSS/JS)
```

The screens talk to the engine only over HTTP (port 5480). A TV or tablet on the home network can use them too (on by default; turn off **Allow other devices** in Settings to keep it to this PC). The first time GarysTV starts, Windows asks whether it may use the network: choose **Allow** for private networks. The engine accepts requests only from this PC, the home network and the TV app, so websites open on the PC can't control it.

**Samsung TV app:** `tizen/` packages the same screens as a Tizen app that connects to this PC (`npm run tizen`). See [tizen/README.md](tizen/README.md) for installing it on the TV.

**Fire TV app:** `firetv/` is a small Android app that shows the same screens full screen and finds GarysTV on the home network. Build it with `npm run firetv`, then `cd firetv && ./gradlew assembleRelease` (needs JDK 17 and the Android SDK); the APK is `firetv/app/build/outputs/apk/release/app-release.apk`. Install it with the Downloader app or `adb install`. GitHub's CI builds it too (and the Windows installer); its APKs are signed with GarysTV's own key from the repo secrets `GTV_KEYSTORE_B64` and `GTV_KEYSTORE_PASSWORD`, so a new one installs over the old one. An APK signed with a different key needs the old app uninstalled first. On the Fire TV remote, ≡ records, and play/pause, rewind and fast-forward work as you'd expect; My Recordings, Timers and Search are on Home.

**My Teams:** Settings > My Teams: pick a league (NFL, college football, NBA, WNBA, college basketball, MLB, NHL, MLS), then your teams. Home gets a *My Teams* row with each team's next games (and the score while one is on), and which of your channels has each game. Games are matched two ways: the **guide** (a listing around kickoff that names the teams, like *NFL Football: Bears at Packers*; this is the only way to find antenna stations named by call sign, and the guide usually covers only the next day or so), and the **TV network** the game is on (a channel with *FOX* or *ESPN2* in its name). Several CBS/FOX/NBC/ABC stations can match, and another city's station may show a different game, so those are marked *may show a different one*. Streaming-only games (Peacock, Prime Video, ESPN+) are listed but have no channel here. Choose a game to watch it (when it's on or about to start) or record it; recordings get an hour extra in case it runs long. Schedules and scores come from ESPN's public site API (no key; schedules kept 3 hours, today's scores 90 seconds).

**Playback health (why is it choppy?):** Settings > Status > *Playback health* says, for each time someone watched live TV, whether it played smoothly and, if not, why: **the channel's own stream** (it dropped out or came in slower than real time: nothing to fix in GarysTV), **this PC couldn't keep up** (the processor was too busy converting the video), **weak network to the TV** (the video was ready here but slow to reach the TV: Wi-Fi), or **a problem inside GarysTV or the TV** (the TV had video waiting and still stuttered, or its decoder reported errors: worth reporting). Each TV reports what it saw every 15 seconds (stutters, download speed, dropped frames); the engine adds what it saw of the stream. A Fire TV shows up under its own name (Settings > My Fire TV > About). While watching, a bad patch shows once on screen as *Choppy: ...* with the cause. The same is at `http://<pc>:5480/api/diag`, and each viewing is written to the activity log, which is now also kept in `activity.log` in the data folder (`%APPDATA%\GarysTV\data` on Windows, `/var/lib/garystv/data` on the home server) so it survives a restart.

**Movies & Shows:** an IPTV provider's on-demand library (Xtream logins) appears under Movies and Shows on Home: categories on the left (English/US first), posters on the right, and a show opens its seasons and episodes. Where you stopped is remembered, and Continue watching picks up there. They play through the engine like recordings, so ← / → skip back and ahead. With a free TMDb key (Settings > Movies & Shows, or `TMDB_KEY` in the server's secrets file) a panel beside the posters shows the highlighted title's poster, rating and synopsis; answers are kept in `data/tmdbcache.json`, and the key never leaves the engine.

**Xfinity:** Settings > Xfinity. Channels ticked there show an *Xfinity* badge in the guide and can be watched in the **Xfinity Stream** app (Fire TV, Samsung TV) or on xfinity.com in the PC's browser. By default they play in GarysTV and Xfinity is offered only when one won't play here (the stream is down, or every plan is busy); *Open Xfinity first* is the other choice. Hold OK on a channel, in the guide or while watching, for *Watch in Xfinity instead*. The Fire TV's Xfinity app (8.16) can't be opened on a given channel: it accepts no channel links, doesn't add its channels to the Fire TV's Live guide, and ignores number and Channel Up keys (tested over ADB, November 2026), so it always opens on its Home screen. **Apply Gary's suggestions** ticks every channel whose name matches the Xfinity lineup, with its Xfinity number (the lineups are in `src/ui/xfinity-lineup.js`; Chicago Popular TV for now). The Xfinity login stays in Xfinity's own app (sign in there once on each TV); GarysTV never stores it or plays Xfinity's video itself (Xfinity has no public API, and its streams are DRM-protected). Xfinity doesn't document a link that opens its app on a given channel, so for now it opens on Xfinity's own screen; when one is found, put it in Settings > Xfinity (`{channel}` becomes the Xfinity number). On a Fire TV, `adb shell dumpsys package com.xfinity.cloudtvr.tenfoot` lists the links the app accepts (under *Schemes*). The Samsung TV needs the Xfinity app's ID, which has to be looked up on the TV itself (with Tizen Studio connected to it) before Xfinity first works there.

**Home server (always on):** on an Ubuntu/Debian machine, `sudo ./install/install-linux.sh` runs the engine without a window as the `garystv` service (port 5480, recordings in `/var/lib/garystv/recordings`, starts on boot). The TV apps find it like they find the PC, and any browser on the home network can open `http://<server>:5480/`. Needs ffmpeg; the installer adds it.

**IPTV subscriptions:** Settings > Sources > *IPTV provider (server, username & password)* takes the login most providers send (an "Xtream Codes" panel). List every server address they gave; GarysTV uses the first that answers. It keeps the US groups unless you list others, numbers the channels from 1000, adds the provider's guide, and records up to the account's stream limit. Providers that send a playlist link instead use *IPTV provider (M3U playlist)*.

**Adding a provider type:** write `src/core/sources/<name>.js` exporting `{ type, label, fields, scan(config) }`, where `scan` returns `{ channels: [{ key, number, name, streamUrl, ... }], tunerCount, info }`, and register it in `sources/index.js`.
