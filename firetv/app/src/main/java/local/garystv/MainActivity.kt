package local.garystv

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Color
import android.os.Bundle
import android.view.KeyEvent
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebView
import java.net.Inet4Address
import java.net.NetworkInterface

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
            webChromeClient = WebChromeClient()
            addJavascriptInterface(Bridge(), "GTVAndroid")
            isFocusable = true
            isFocusableInTouchMode = true
        }
        setContentView(web)
        web.requestFocus()
        web.loadUrl("file:///android_asset/www/index.html")
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val code = remote[event.keyCode] ?: return super.dispatchKeyEvent(event)
        if (event.action == KeyEvent.ACTION_DOWN) {
            // Back before the screens have loaded just leaves the app.
            web.evaluateJavascript("window.GTV_REMOTE ? (GTV_REMOTE($code), true) : false") { handled ->
                if (handled == "false" && code == 10009) finish()
            }
        }
        return true
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
        // This Fire TV's home-network address; tv.js searches the addresses next to it for the server.
        @JavascriptInterface
        fun ipAddress(): String =
            NetworkInterface.getNetworkInterfaces().toList()
                .filter { it.isUp && !it.isLoopback }
                .flatMap { it.inetAddresses.toList() }
                .filterIsInstance<Inet4Address>()
                .firstOrNull { it.isSiteLocalAddress }
                ?.hostAddress ?: ""

        @JavascriptInterface
        fun exit() = runOnUiThread { finish() }
    }
}
