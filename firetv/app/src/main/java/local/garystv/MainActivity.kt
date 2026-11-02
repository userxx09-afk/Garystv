package local.garystv

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Socket
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import kotlin.concurrent.thread

// Fire TV side of GarysTV: the same screens as the PC and Samsung apps (bundled in
// assets/www with tizen/tv.js), shown full screen. tv.js finds the GarysTV server on
// the home network and turns remote buttons into the keys the screens understand.
class MainActivity : Activity() {
    private lateinit var web: WebView

    // Fire TV remote buttons the WebView doesn't pass on (or passes as something
    // else) -> the Samsung remote codes tv.js already maps.
    private val remote = mapOf(
        KeyEvent.KEYCODE_BACK to 10009,
        KeyEvent.KEYCODE_MENU to 403, // ≡ : record (Fire TV remotes have no red button)
        KeyEvent.KEYCODE_PROG_RED to 403,
        KeyEvent.KEYCODE_PROG_GREEN to 404,
        KeyEvent.KEYCODE_PROG_YELLOW to 405,
        KeyEvent.KEYCODE_PROG_BLUE to 406,
        KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE to 10252,
        KeyEvent.KEYCODE_MEDIA_PLAY to 10252,
        KeyEvent.KEYCODE_MEDIA_PAUSE to 10252,
        KeyEvent.KEYCODE_MEDIA_STOP to 413,
        KeyEvent.KEYCODE_MEDIA_REWIND to 412,
        KeyEvent.KEYCODE_MEDIA_FAST_FORWARD to 417,
        KeyEvent.KEYCODE_CHANNEL_UP to 427,
        KeyEvent.KEYCODE_CHANNEL_DOWN to 428,
        KeyEvent.KEYCODE_GUIDE to 458,
        KeyEvent.KEYCODE_INFO to 457,
    )

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        web = WebView(this).apply {
            setBackgroundColor(Color.parseColor("#05070c"))
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true // remembers the server's address
            settings.mediaPlaybackRequiresUserGesture = false
            // The page says width=1920; show all of it, scaled to the screen, at the size it was designed.
            settings.useWideViewPort = true
            settings.loadWithOverviewMode = true
            settings.textZoom = 100
            settings.setSupportZoom(false)
            webChromeClient = WebChromeClient()
            addJavascriptInterface(Bridge(), "GTVAndroid")
            isFocusable = true
            isFocusableInTouchMode = true
        }
        setContentView(web)
        web.requestFocus()
        web.loadUrl("file:///android_asset/www/index.html")
    }

    // OK: a press is an ordinary OK (sent when it's let go); held for a moment, it's 10001, which
    // tv.js turns into the options menu while watching.
    private val handler = Handler(Looper.getMainLooper())
    private var okHeld = false
    private var okDown: KeyEvent? = null
    private val okHold = Runnable { okHeld = true; send(10001) }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.keyCode == KeyEvent.KEYCODE_DPAD_CENTER || event.keyCode == KeyEvent.KEYCODE_ENTER) {
            if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
                okHeld = false
                okDown = KeyEvent(event)
                handler.postDelayed(okHold, 600)
            } else if (event.action == KeyEvent.ACTION_UP) {
                handler.removeCallbacks(okHold)
                // A press: hand the real button press to the page (so OK on a text box still brings up the keyboard).
                val down = okDown
                if (!okHeld && down != null) {
                    super.dispatchKeyEvent(down)
                    super.dispatchKeyEvent(event)
                }
                okDown = null
            }
            return true
        }
        val code = remote[event.keyCode] ?: return super.dispatchKeyEvent(event)
        if (event.action == KeyEvent.ACTION_DOWN) send(code)
        return true
    }

    private fun send(code: Int) {
        // Back before the screens have loaded just leaves the app.
        web.evaluateJavascript("window.GTV_REMOTE ? (GTV_REMOTE($code), true) : false") { handled ->
            if (handled == "false" && code == 10009) finish()
        }
    }

    // Leaving the app (Home button) stops what's playing, so the server isn't streaming to nobody.
    override fun onStop() {
        super.onStop()
        web.evaluateJavascript("window.Player && Player.mode && Player.stop(); window.App && App.render && App.render();", null)
    }

    override fun onDestroy() {
        web.destroy()
        super.onDestroy()
    }

    inner class Bridge {
        // This Fire TV's home-network address and the network's size, e.g. "192.168.5.40/22";
        // tv.js searches that network for the server.
        @JavascriptInterface
        fun ipAddress(): String =
            NetworkInterface.getNetworkInterfaces().toList()
                .filter { it.isUp && !it.isLoopback }
                .flatMap { it.interfaceAddresses }
                .firstOrNull { (it.address as? Inet4Address)?.isSiteLocalAddress == true }
                ?.let { "${it.address.hostAddress}/${it.networkPrefixLength}" } ?: ""

        // Which of these addresses have the GarysTV port open; answers through GTV_SCANNED([...]).
        @JavascriptInterface
        fun scan(hosts: String, port: Int) {
            thread {
                val pool = Executors.newFixedThreadPool(64)
                val open = try {
                    pool.invokeAll(hosts.split(',').filter { it.isNotBlank() }.map { host ->
                        Callable {
                            try {
                                Socket().use { it.connect(InetSocketAddress(host, port), 700) }
                                host
                            } catch (_: Exception) {
                                null
                            }
                        }
                    }).mapNotNull { it.get() }
                } finally {
                    pool.shutdown()
                }
                val list = open.joinToString(",") { "\"$it\"" }
                runOnUiThread { web.evaluateJavascript("window.GTV_SCANNED && GTV_SCANNED([$list])", null) }
            }
        }

        @JavascriptInterface
        fun exit() = runOnUiThread { finish() }

        // VLC, the backup player. url is GarysTV's /direct/ address for the video.
        @JavascriptInterface
        fun hasVlc(): Boolean = try {
            packageManager.getPackageInfo(VLC, 0)
            true
        } catch (_: PackageManager.NameNotFoundException) {
            false
        }

        @JavascriptInterface
        fun openVlc(url: String, title: String) = runOnUiThread {
            val play = Intent(Intent.ACTION_VIEW).setPackage(VLC)
                .setDataAndTypeAndNormalize(Uri.parse(url), "video/*")
                .putExtra("title", title)
            try {
                startActivity(play)
            } catch (_: ActivityNotFoundException) {
                // Not installed: its page in the app store (Amazon's on a Fire TV, else Google Play).
                val amazon = Intent(Intent.ACTION_VIEW, Uri.parse("amzn://apps/android?p=$VLC"))
                val google = Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=$VLC"))
                try { startActivity(amazon) } catch (_: ActivityNotFoundException) {
                    try { startActivity(google) } catch (_: ActivityNotFoundException) { }
                }
            }
        }
    }

    private companion object {
        const val VLC = "org.videolan.vlc"
    }
}
