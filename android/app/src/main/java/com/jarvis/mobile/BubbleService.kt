package com.jarvis.mobile

import android.animation.ValueAnimator
import android.annotation.SuppressLint
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import android.view.animation.OvershootInterpolator
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.TextView
import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.min

/**
 * The floating Jarvis: a small circle with an animated companion that stays on screen over every app.
 * Runs as a foreground service so it survives in the background and can listen for the wake word.
 *
 * Touch: tap = talk · double-tap = open the full app · hold = pet · drag = move (snaps to the edge)
 * Drop it on the ✕ at the bottom to close it.
 */
class BubbleService : Service() {

    companion object {
        const val ACTION_STOP = "com.jarvis.mobile.STOP"
        const val ACTION_TALK = "com.jarvis.mobile.TALK"
        const val ACTION_RELOAD = "com.jarvis.mobile.RELOAD"
        const val NOTIFICATION_ID = 7

        @Volatile
        var instance: BubbleService? = null
            private set
    }

    private val main = Handler(Looper.getMainLooper())
    private lateinit var wm: WindowManager
    private lateinit var root: DragLayout
    private lateinit var web: WebView
    private lateinit var bridge: JarvisBridge
    private lateinit var params: WindowManager.LayoutParams
    private var trash: TextView? = null

    private var expanded = false
    private var onRight = true
    private var ballX = 0           // window x when collapsed
    private var talkWhenReady = false
    private var pageReady = false

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
    private val ballPx get() = dp(64)              // 52dp ball + 6dp margin each side (see buddy.css)
    private val screenW get() = resources.displayMetrics.widthPixels
    private val screenH get() = resources.displayMetrics.heightPixels
    private val expandedW get() = min(screenW - dp(8), dp(340))
    private val expandedH get() = dp(190)

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        if (!goForeground() || !Settings.canDrawOverlays(this)) { stopSelf(); return }
        wm = getSystemService(WindowManager::class.java)
        createBubble()
        instance = this
    }

    private fun goForeground(): Boolean {
        val n = Notifications.bubble(this)
        val hasMic = checkSelfPermission(android.Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        try {
            when {
                Build.VERSION.SDK_INT >= 34 -> startForeground(
                    NOTIFICATION_ID, n,
                    if (hasMic) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
                    else ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
                )
                Build.VERSION.SDK_INT >= 30 && hasMic -> startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
                else -> startForeground(NOTIFICATION_ID, n)
            }
        } catch (e: Exception) {
            // e.g. started at boot, where Android doesn't allow microphone services. Run without the mic type.
            try {
                if (Build.VERSION.SDK_INT >= 34) startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
                else startForeground(NOTIFICATION_ID, n)
            } catch (again: Exception) {
                return false
            }
        }
        return true
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun createBubble() {
        web = WebView(this)
        bridge = JarvisBridge(this, web, bubble = this)
        WebSetup.configure(web, bridge, bubble = true) {
            pageReady = true
            sendSide()
            if (talkWhenReady) { talkWhenReady = false; talk() }
        }

        root = DragLayout(this)
        root.addView(web, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))

        val type = WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
        params = WindowManager.LayoutParams(
            ballPx, ballPx, type,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            val saved = Prefs.bubblePos(this@BubbleService)
            onRight = saved?.first ?: true
            ballX = if (onRight) screenW - ballPx else 0
            x = ballX
            y = saved?.second ?: (screenH * 0.35).toInt()
        }
        wm.addView(root, params)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> { stopSelf(); return START_NOT_STICKY }
            ACTION_TALK -> talk()
            ACTION_RELOAD -> reloadSoon()
        }
        return START_STICKY
    }

    override fun onDestroy() {
        instance = null
        main.removeCallbacksAndMessages(null)
        if (::root.isInitialized) {
            try { wm.removeView(root) } catch (ignored: Exception) {}
            removeTrash()
            bridge.destroy()
            web.destroy()
        }
        super.onDestroy()
    }

    // ------------------------------------------------------------------ called from JS / others

    fun talk() {
        if (!::bridge.isInitialized) return
        if (!pageReady) { talkWhenReady = true; return }
        bridge.js("window.__jarvisTalk && window.__jarvisTalk()")
    }

    fun alert(title: String, body: String) {
        if (!::bridge.isInitialized) return
        bridge.js("window.__jarvisAlert && window.__jarvisAlert(${JSONObject.quote(title)}, ${JSONObject.quote(body)})")
    }

    private val reload = Runnable { if (::web.isInitialized) { pageReady = false; web.reload() } }
    fun reloadSoon() = main.post {
        main.removeCallbacks(reload)
        main.postDelayed(reload, 1200)
    }

    /** JS shows/hides the speech caption next to the ball: grow/shrink the window around it. */
    fun setExpanded(want: Boolean) = main.post {
        if (want == expanded || !::root.isInitialized) return@post
        expanded = want
        if (want) {
            params.width = expandedW
            params.height = expandedH
            params.x = if (onRight) ballX + ballPx - expandedW else ballX
            params.y = min(params.y, screenH - expandedH)
        } else {
            params.width = ballPx
            params.height = ballPx
            params.x = ballX
        }
        safeUpdate()
    }

    private fun sendSide() = bridge.js("window.__jarvisSide && window.__jarvisSide('${if (onRight) "right" else "left"}')")

    private fun safeUpdate() {
        try { wm.updateViewLayout(root, params) } catch (ignored: Exception) {}
    }

    // ------------------------------------------------------------------ dragging (native, smooth)

    private inner class DragLayout(ctx: Context) : FrameLayout(ctx) {
        private val slop = ViewConfiguration.get(ctx).scaledTouchSlop * 1.5f
        private var downX = 0f
        private var downY = 0f
        private var startX = 0
        private var startY = 0
        private var dragging = false

        override fun onInterceptTouchEvent(e: MotionEvent): Boolean {
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> { downX = e.rawX; downY = e.rawY; dragging = false }
                MotionEvent.ACTION_MOVE -> if (!dragging && hypot(e.rawX - downX, e.rawY - downY) > slop) {
                    dragging = true
                    beginDrag()
                    startX = params.x
                    startY = params.y
                    return true
                }
            }
            return dragging
        }

        @SuppressLint("ClickableViewAccessibility")
        override fun onTouchEvent(e: MotionEvent): Boolean {
            if (!dragging) return super.onTouchEvent(e)
            when (e.actionMasked) {
                MotionEvent.ACTION_MOVE -> {
                    params.x = startX + (e.rawX - downX).toInt()
                    params.y = startY + (e.rawY - downY).toInt()
                    safeUpdate()
                    highlightTrash(e.rawX, e.rawY)
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    dragging = false
                    endDrag(e.rawX, e.rawY)
                }
            }
            return true
        }
    }

    private fun beginDrag() {
        setExpandedNow(false)
        bridge.js("window.__jarvisDrag && window.__jarvisDrag('start')")
        showTrash()
    }

    private fun setExpandedNow(want: Boolean) {
        if (!want && expanded) {
            expanded = false
            params.width = ballPx; params.height = ballPx; params.x = ballX
            safeUpdate()
        }
    }

    private fun endDrag(rawX: Float, rawY: Float) {
        val overTrash = isOverTrash(rawX, rawY)
        removeTrash()
        if (overTrash) {
            Prefs.setBubbleWanted(this, false)
            stopSelf()
            return
        }
        onRight = params.x + ballPx / 2 > screenW / 2
        val targetX = if (onRight) screenW - ballPx else 0
        val y = params.y.coerceIn(dp(24), screenH - ballPx - dp(24))
        ValueAnimator.ofInt(params.x, targetX).apply {
            duration = 350
            interpolator = OvershootInterpolator(1.2f)
            addUpdateListener { params.x = it.animatedValue as Int; params.y = y; safeUpdate() }
            start()
        }
        ballX = targetX
        Prefs.setBubblePos(this, onRight, y)
        sendSide()
        bridge.js("window.__jarvisDrag && window.__jarvisDrag('end')")
    }

    // ------------------------------------------------------------------ the ✕ drop target

    private fun showTrash() {
        if (trash != null) return
        val t = TextView(this).apply {
            text = "✕"
            textSize = 22f
            setTextColor(Color.WHITE)
            gravity = Gravity.CENTER
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.argb(200, 20, 28, 40))
                setStroke(dp(2), Color.argb(160, 255, 255, 255))
            }
            alpha = 0f
            animate().alpha(1f).setDuration(150).start()
        }
        val lp = WindowManager.LayoutParams(
            dp(64), dp(64), WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
            y = dp(56)
        }
        try { wm.addView(t, lp); trash = t } catch (ignored: Exception) {}
    }

    private fun isOverTrash(rawX: Float, rawY: Float): Boolean {
        val cx = screenW / 2f
        val cy = screenH - dp(56) - dp(32)
        return abs(rawX - cx) < dp(70) && abs(rawY - cy) < dp(90)
    }

    private fun highlightTrash(rawX: Float, rawY: Float) {
        val t = trash ?: return
        val over = isOverTrash(rawX, rawY)
        val s = if (over) 1.3f else 1f
        if (t.scaleX != s) t.animate().scaleX(s).scaleY(s).setDuration(120).start()
        (t.background as? GradientDrawable)?.setColor(if (over) Color.argb(220, 220, 60, 70) else Color.argb(200, 20, 28, 40))
    }

    private fun removeTrash() {
        trash?.let { try { wm.removeView(it) } catch (ignored: Exception) {} }
        trash = null
    }
}
