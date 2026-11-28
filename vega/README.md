# GarysTV for Vega Fire TV sticks

The newer Fire TV sticks (Fire TV Stick 4K Select and other **Vega OS** models) run Linux, not
Android, so they can't install `GarysTV.apk`. They get their own app, `GarysTV-Vega.vpkg`.

It shows the same screens as the other TV apps (live TV, Guide, recordings...), and finds the
GarysTV server on the home network the same way: if it doesn't find it, type the server's address
(GarysTV > Settings > Recording on the PC). It remembers the last server it connected to and goes
straight to it next time if it answers; if it doesn't, it searches the network again (the app
passes the stick's own address to the page so it knows where to look) and shows the address box.

## How it's built

CI builds it with every change (`.github/workflows/ci.yml`, job *Vega Fire TV app*), because
Amazon's Vega SDK only runs on Ubuntu or Mac:

1. installs the Vega SDK,
2. `vega project generate --template vegaWebview` makes a fresh Vega WebView app,
3. `node vega/build.js <that folder>` puts our screens (`src/ui` + `tizen/tv.js`) in its
   `assets/www`, our `App.tsx` (a full-screen WebView) in `src`, and sets the name, icon,
   version and plain-http permission in `manifest.toml`,
4. `npm run build:app` makes the `.vpkg`.

The newest one is always at
`https://github.com/userxx09-afk/prod/releases/download/garystv-latest/GarysTV-Vega.vpkg`.

## Installing it on a stick (Developer Mode, one time per stick)

Vega apps that aren't from the Appstore install only in Developer Mode, with the Vega CLI on an
Ubuntu or Mac computer (or Ubuntu in WSL on Windows) on the same network as the stick:

```
curl -fsSL https://sdk-installer.vega.labcollab.net/get_vvm.sh | bash && source ~/vega/env
vega devmode login                       # free Amazon Developer account
vega devmode enable-device --code <the 6-character code the TV shows>
vega device list                         # the stick's serial
curl -fLO https://github.com/userxx09-afk/prod/releases/download/garystv-latest/GarysTV-Vega.vpkg
vega device install-app -p GarysTV-Vega.vpkg --device <serial>
vega device launch-app --device <serial> --appName com.garystv.tv.main
```

To update: download the newest `.vpkg` and run `install-app` again. It doesn't update itself
(Vega has no way for a sideloaded app to do that).

## The remote

Same as the other Fire TV app: arrows and OK move and select, Back goes back (and closes the app
on Home), ⏯ plays/pauses, ⏪ ⏩ skip. Home has My Recordings, Timers, Search and the Guide.
