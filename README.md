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
| Recording storage | Any internal or USB drive | Settings > Recording > folder. About 3–7 GB per hour of HD over-the-air TV. |
| Watching on this PC | **ffmpeg** (built-in player) or **VLC** | OTA TV is MPEG-2, which needs converting to play in-app. Recording does not need either. Install with `winget install Gyan.FFmpeg`; GarysTV finds it automatically. |

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
| Watching live TV | ← back 10s, → ahead 30s, Space pause, L (or fast-forward to the end) back to live, ↑↓ change channel, G guide with picture-in-picture |
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
  server.js             HTTP API + video stream + serves the screens
src/ui/                 the screens (plain HTML/CSS/JS)
```

The screens talk to the engine only over HTTP (port 5480). A TV or tablet on the home network can use them too (on by default; turn off **Allow other devices** in Settings to keep it to this PC). The first time GarysTV starts, Windows asks whether it may use the network: choose **Allow** for private networks. The engine accepts requests only from this PC, the home network and the TV app, so websites open on the PC can't control it.

**Samsung TV app:** `tizen/` packages the same screens as a Tizen app that connects to this PC (`npm run tizen`). See [tizen/README.md](tizen/README.md) for installing it on the TV.

**Fire TV app:** `firetv/` is a small Android app that shows the same screens full screen and finds GarysTV on the home network. Build it with `npm run firetv`, then `cd firetv && ./gradlew assembleRelease` (needs JDK 17 and the Android SDK); the APK is `firetv/app/build/outputs/apk/release/app-release.apk`. Install it with the Downloader app or `adb install`. GitHub's CI builds it too (and the Windows installer); its APKs are signed with GarysTV's own key from the repo secrets `GTV_KEYSTORE_B64` and `GTV_KEYSTORE_PASSWORD`, so a new one installs over the old one. An APK signed with a different key needs the old app uninstalled first. On the Fire TV remote, ≡ records, and play/pause, rewind and fast-forward work as you'd expect; My Recordings, Timers and Search are on Home.

**Movies & Shows:** an IPTV provider's on-demand library (Xtream logins) appears under Movies and Shows on Home: categories on the left (English/US first), posters on the right, and a show opens its seasons and episodes. Where you stopped is remembered, and Continue watching picks up there. They play through the engine like recordings, so ← / → skip back and ahead.

**Home server (always on):** on an Ubuntu/Debian machine, `sudo ./install/install-linux.sh` runs the engine without a window as the `garystv` service (port 5480, recordings in `/var/lib/garystv/recordings`, starts on boot). The TV apps find it like they find the PC, and any browser on the home network can open `http://<server>:5480/`. Needs ffmpeg; the installer adds it.

**IPTV subscriptions:** Settings > Sources > *IPTV provider (server, username & password)* takes the login most providers send (an "Xtream Codes" panel). List every server address they gave; GarysTV uses the first that answers. It keeps the US groups unless you list others, numbers the channels from 1000, adds the provider's guide, and records up to the account's stream limit. Providers that send a playlist link instead use *IPTV provider (M3U playlist)*.

**Adding a provider type:** write `src/core/sources/<name>.js` exporting `{ type, label, fields, scan(config) }`, where `scan` returns `{ channels: [{ key, number, name, streamUrl, ... }], tunerCount, info }`, and register it in `sources/index.js`.
