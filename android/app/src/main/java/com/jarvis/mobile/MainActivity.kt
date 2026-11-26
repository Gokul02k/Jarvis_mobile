package com.jarvis.mobile

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/** The full-screen Jarvis app (chat, settings, permissions). The floating bubble is BubbleService. */
class MainActivity : Activity() {

    companion object {
        const val EXTRA_TALK = "talk"
        const val EXTRA_RUN = "run"
    }

    private lateinit var web: WebView
    private lateinit var bridge: JarvisBridge
    private var ready = false
    private var talkPending = false
    private var runPending: String? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val frame = FrameLayout(this)
        web = WebView(this)
        frame.addView(web, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
        setContentView(frame)

        // Keep the page clear of the status bar, navigation bar and keyboard (Android 15 is edge-to-edge).
        ViewCompat.setOnApplyWindowInsetsListener(frame) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }

        bridge = JarvisBridge(this, web, activity = this)
        talkPending = intent?.getBooleanExtra(EXTRA_TALK, false) == true || intent?.action == Intent.ACTION_ASSIST
        runPending = intent?.getStringExtra(EXTRA_RUN)
        WebSetup.configure(web, bridge, bubble = false) {
            ready = true
            if (talkPending) { talkPending = false; talk() }
            runPending?.let { runPending = null; run(it) }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.getBooleanExtra(EXTRA_TALK, false) || intent.action == Intent.ACTION_ASSIST) {
            if (ready) talk() else talkPending = true
        }
        intent.getStringExtra(EXTRA_RUN)?.let { if (ready) run(it) else runPending = it }
    }

    private fun run(command: String) =
        bridge.js("setTimeout(() => window.__jarvisRun && window.__jarvisRun(${org.json.JSONObject.quote(command)}), 600)")

    private fun talk() = bridge.js("setTimeout(() => window.__jarvisTalk && window.__jarvisTalk(), 400)")

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        // Continue the permission walkthrough (overlay, exact alarms) after the runtime prompts.
        bridge.permissionSteps(askRuntime = false)
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        // Let the page close Settings / the keyboard bar first; only then leave the app.
        if (!ready) { moveTaskToBack(true); return }
        web.evaluateJavascript("window.__jarvisBack ? window.__jarvisBack() : false") { handled ->
            if (handled == "true") return@evaluateJavascript
            if (web.canGoBack()) web.goBack() else moveTaskToBack(true)
        }
    }

    override fun onDestroy() {
        bridge.destroy()
        web.destroy()
        super.onDestroy()
    }
}
