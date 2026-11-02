# GarysTV for Samsung TVs (Tizen)

The TV app shows the same guide, recordings and timers as the PC, and plays live TV and recordings streamed from the PC. **The PC still does all the recording**, so it must be on (or at least not asleep) for the TV to work.

Works on Samsung smart TVs from 2017 on (Tizen 3.0 or newer).

## 1. Get the PC ready

1. Install the current GarysTV on the PC (`npm run dist`, then run `dist/GarysTV-Setup-*.exe`). The TV needs this version or newer.
2. When Windows Firewall asks about GarysTV, allow **Private networks**. (Home-network access is on by default; if you upgraded and GarysTV was already running, quit it from the tray icon and start it again.)
3. The TV app finds the PC by itself, and finds it again if the PC's address changes. If it can't, type the address shown in **Settings > Recording** on the PC.

## 2. Put the TV in Developer Mode (one time)

1. On the TV, open **Apps**.
2. On the remote, press **1 2 3 4 5**. A Developer Mode box appears.
3. Turn Developer Mode **On**, enter the **PC's IP address** as Host PC IP, choose OK.
4. Turn the TV fully off and on (hold the power button until the logo shows).

## 3. Install Tizen Studio on the PC (one time)

1. Download **Tizen Studio with IDE installer** from developer.tizen.org and install it.
2. Open **Package Manager** (from the Tizen Studio folder) > **Extension SDK** tab, install:
   * **TV Extensions** (the newest)
   * **Samsung Certificate Extension**

## 4. Make a Samsung certificate (one time)

Samsung TVs only install apps signed with a Samsung certificate tied to that TV.

1. In Tizen Studio open **Tools > Device Manager**, click **Remote Device Manager**, add the TV by its IP address (TV: Settings > General > Network > Network Status > IP Settings), and switch it **On** (connected).
2. Open **Tools > Certificate Manager**, click **+**, choose **Samsung**, then **TV**.
3. Create a new **author** certificate (any name/password), sign in with a Samsung account when asked.
4. Create a **distributor** certificate. The connected TV's DUID is filled in automatically; keep it.
5. Note the certificate profile name you gave it (for example `GarysTV`).

## 5. Build and install the TV app

From the `homedvr` folder on the PC:

```
npm run tizen
```

Then, with Tizen Studio's tools (default folder `C:\tizen-studio`):

```
C:\tizen-studio\tools\sdb.exe connect <TV-IP>
C:\tizen-studio\tools\ide\bin\tizen.bat package -t wgt -s GarysTV -- tizen\build
C:\tizen-studio\tools\ide\bin\tizen.bat install -n GarysTV.wgt -- tizen\build
```

GarysTV appears in the TV's **Apps**. Open it: it searches the home network and lists the GarysTV PC. Pick it (or type the PC's address). The TV remembers it next time.

To update later: run the same three commands again.

## The remote

| Button | Does |
|---|---|
| Arrows, OK | Move, select |
| BACK | Back; on the Home screen it closes the app |
| GUIDE | Guide (while watching, the channel keeps playing in the corner) |
| CH ▲ / CH ▼ | Change channel while watching; page the guide |
| 0–9 | Jump to a channel in the guide |
| ● Red | Record (press again for the series, again to cancel) |
| ● Green / ● Yellow / ● Blue | My Recordings / Timers / Search |
| ⏯ Play/Pause, ⏹ Stop | Pause / stop |
| ⏪ / ⏩ | Back 10s / skip 30s in a recording; previous / next day in the guide |

## If something goes wrong

* **"No GarysTV PC found"**: check steps 1–2 (GarysTV running and allowed through the firewall), that the TV and PC are on the same network, then choose **Search again** or type the PC's address.
* **Nothing plays**: ffmpeg must be installed on the PC (`winget install Gyan.FFmpeg`).
* **Test without a TV**: run `npm run tizen` and open `tizen/build/index.html` through any local web server; the app works in a normal browser (without remote-only buttons).
