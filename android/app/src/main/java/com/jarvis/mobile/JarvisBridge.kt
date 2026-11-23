package com.jarvis.mobile

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlarmManager
import android.app.PendingIntent
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.AudioManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.os.VibrationEffect
import android.os.Vibrator
import android.provider.AlarmClock
import android.provider.ContactsContract
import android.provider.MediaStore
import android.provider.Settings
import android.view.KeyEvent
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.Calendar
import java.util.concurrent.Executors

/**
 * Everything the Jarvis web app can ask the phone to do. Exposed to JS as window.JarvisNative.
 * One bridge per WebView: the full-screen app (activity != null) or the floating bubble (bubble != null).
 */
class JarvisBridge(
    private val ctx: Context,
    private val web: WebView,
    private val activity: Activity? = null,
    private val bubble: BubbleService? = null,
) {
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newCachedThreadPool()
    private var torchOn = false

    val voice = Voice(
        ctx,
        emit = { json -> js("window.__jarvisSpeech && window.__jarvisSpeech(${JSONObject.quote(json)})") },
        ttsDone = { id -> js("window.__jarvisTts && window.__jarvisTts(${JSONObject.quote(id)})") },
    )

    fun js(code: String) = main.post { web.evaluateJavascript(code, null) }

    private fun callback(id: String, obj: JSONObject) =
        js("window.__jarvisNative(${JSONObject.quote(id)}, ${JSONObject.quote(obj.toString())})")

    private fun ok(vararg kv: Pair<String, Any?>): String {
        val o = JSONObject().put("ok", true)
        kv.forEach { (k, v) -> o.put(k, v) }
        return o.toString()
    }

    private fun fail(msg: String) = JSONObject().put("ok", false).put("error", msg).toString()

    private fun has(perm: String) = ctx.checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED

    private fun start(intent: Intent): Boolean = try {
        ctx.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        true
    } catch (e: Exception) {
        false
    }

    fun destroy() {
        voice.destroy()
        io.shutdownNow()
    }

    // ================================================================== speech

    @JavascriptInterface fun startListening(lang: String, continuous: Boolean) { voice.startListening(lang, continuous) }
    @JavascriptInterface fun stopListening() { voice.stopListening() }
    @JavascriptInterface fun speak(id: String, text: String, lang: String, rate: String, voiceName: String) {
        voice.speak(id, text, lang, rate.toFloatOrNull() ?: 1f, voiceName)
    }
    @JavascriptInterface fun stopSpeaking() { voice.stopSpeaking() }
    @JavascriptInterface fun voices(): String = voice.voices()

    // ================================================================== networking (no CORS, works in background)

    @JavascriptInterface
    fun http(id: String, url: String, method: String, headersJson: String, body: String) {
        io.execute {
            val out = JSONObject()
            try {
                val conn = URL(url).openConnection() as HttpURLConnection
                conn.requestMethod = method.uppercase()
                conn.connectTimeout = 20_000
                conn.readTimeout = 180_000
                val headers = try { JSONObject(headersJson) } catch (ignored: Exception) { JSONObject() }
                headers.keys().forEach { conn.setRequestProperty(it, headers.optString(it)) }
                if (body.isNotEmpty() && conn.requestMethod != "GET") {
                    conn.doOutput = true
                    conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                }
                val status = conn.responseCode
                val stream = if (status >= 400) conn.errorStream else conn.inputStream
                val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""
                out.put("status", status).put("body", text)
                conn.disconnect()
            } catch (e: Exception) {
                out.put("error", "Network error: ${e.message ?: e.javaClass.simpleName}")
            }
            callback(id, out)
        }
    }

    // ================================================================== launching things

    @JavascriptInterface
    fun openUrl(url: String): Boolean {
        val intent = try {
            if (url.startsWith("intent:")) Intent.parseUri(url, Intent.URI_INTENT_SCHEME).apply { selector = null; component = null }
            else Intent(Intent.ACTION_VIEW, Uri.parse(url))
        } catch (e: Exception) {
            return false
        }
        if (start(intent)) return true
        val fallback = intent.getStringExtra("browser_fallback_url")
        return fallback != null && start(Intent(Intent.ACTION_VIEW, Uri.parse(fallback)))
    }

    @JavascriptInterface
    fun launchApp(name: String): String {
        val pm = ctx.packageManager
        val q = name.lowercase().trim().removePrefix("the ").removeSuffix(" app")
        val apps = pm.queryIntentActivities(
            Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0
        ).map { it.loadLabel(pm).toString() to it.activityInfo.packageName }
        val best = apps.firstOrNull { it.first.lowercase() == q }
            ?: apps.firstOrNull { it.first.lowercase().startsWith(q) }
            ?: apps.firstOrNull { it.first.lowercase().contains(q) }
            ?: apps.firstOrNull { q.contains(it.first.lowercase()) && it.first.length > 2 }
            ?: return fail("No installed app called $name")
        val launch = pm.getLaunchIntentForPackage(best.second) ?: return fail("Can't open ${best.first}")
        return if (start(launch)) ok("app" to best.first) else fail("Can't open ${best.first}")
    }

    @JavascriptInterface fun openApp() {
        start(Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT))
    }

    @JavascriptInterface
    fun share(text: String) {
        val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, text)
        start(Intent.createChooser(send, "Share via"))
    }

    @JavascriptInterface
    fun camera(video: String): String {
        val action = if (video == "true") MediaStore.INTENT_ACTION_VIDEO_CAMERA else MediaStore.INTENT_ACTION_STILL_IMAGE_CAMERA
        return if (start(Intent(action))) ok() else fail("No camera app")
    }

    @JavascriptInterface
    fun openSettings(page: String): String {
        val action = when (page) {
            "wifi", "mobile_data" -> if (Build.VERSION.SDK_INT >= 29) Settings.Panel.ACTION_INTERNET_CONNECTIVITY else Settings.ACTION_WIFI_SETTINGS
            "bluetooth" -> Settings.ACTION_BLUETOOTH_SETTINGS
            "airplane" -> Settings.ACTION_AIRPLANE_MODE_SETTINGS
            "display" -> Settings.ACTION_DISPLAY_SETTINGS
            "sound" -> if (Build.VERSION.SDK_INT >= 29) Settings.Panel.ACTION_VOLUME else Settings.ACTION_SOUND_SETTINGS
            "battery" -> Settings.ACTION_BATTERY_SAVER_SETTINGS
            "location" -> Settings.ACTION_LOCATION_SOURCE_SETTINGS
            "apps" -> Settings.ACTION_APPLICATION_SETTINGS
            "notifications" -> "android.settings.NOTIFICATION_SETTINGS"
            "hotspot" -> Settings.ACTION_WIRELESS_SETTINGS
            "do_not_disturb" -> "android.settings.ZEN_MODE_SETTINGS"
            "date_time" -> Settings.ACTION_DATE_SETTINGS
            "accessibility" -> Settings.ACTION_ACCESSIBILITY_SETTINGS
            "storage" -> Settings.ACTION_INTERNAL_STORAGE_SETTINGS
            else -> Settings.ACTION_SETTINGS
        }
        return if (start(Intent(action)) || start(Intent(Settings.ACTION_SETTINGS))) ok("opened" to page) else fail("Can't open settings")
    }

    // ================================================================== phone, contacts

    @SuppressLint("MissingPermission")
    @JavascriptInterface
    fun call(number: String): String {
        val direct = has(Manifest.permission.CALL_PHONE)
        val intent = Intent(if (direct) Intent.ACTION_CALL else Intent.ACTION_DIAL, Uri.parse("tel:" + Uri.encode(number)))
        return if (start(intent)) ok("calling" to number, "direct" to direct,
            "note" to if (direct) "Call started" else "Dialer opened; the user taps call (grant Phone permission for direct calls)")
        else fail("No phone app")
    }

    @JavascriptInterface
    fun findContacts(name: String): String {
        val arr = JSONArray()
        if (!has(Manifest.permission.READ_CONTACTS) || name.isBlank()) return arr.toString()
        val seen = HashSet<String>()
        try {
            ctx.contentResolver.query(
                ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
                arrayOf(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME, ContactsContract.CommonDataKinds.Phone.NUMBER),
                "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} LIKE ?",
                arrayOf("%${name.trim()}%"),
                "${ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME} ASC",
            )?.use { c ->
                while (c.moveToNext() && arr.length() < 8) {
                    val n = c.getString(0) ?: continue
                    val num = (c.getString(1) ?: continue).replace(Regex("[^\\d+]"), "")
                    if (seen.add(num)) arr.put(JSONObject().put("name", n).put("number", num))
                }
            }
        } catch (ignored: Exception) {}
        return arr.toString()
    }

    // ================================================================== clock: timers, alarms, reminders

    @JavascriptInterface
    fun setTimer(seconds: String, label: String): String {
        val s = seconds.toIntOrNull() ?: return fail("Bad duration")
        val intent = Intent(AlarmClock.ACTION_SET_TIMER)
            .putExtra(AlarmClock.EXTRA_LENGTH, s)
            .putExtra(AlarmClock.EXTRA_MESSAGE, label)
            .putExtra(AlarmClock.EXTRA_SKIP_UI, true)
        return if (start(intent)) ok("seconds" to s, "label" to label) else fail("No clock app")
    }

    @JavascriptInterface
    fun setAlarm(hour: String, minute: String, label: String, days: String): String {
        val dayMap = mapOf(
            "sun" to Calendar.SUNDAY, "mon" to Calendar.MONDAY, "tue" to Calendar.TUESDAY, "wed" to Calendar.WEDNESDAY,
            "thu" to Calendar.THURSDAY, "fri" to Calendar.FRIDAY, "sat" to Calendar.SATURDAY,
        )
        val repeat = ArrayList(days.lowercase().split(Regex("[,\\s]+")).mapNotNull { dayMap[it.take(3)] })
        val intent = Intent(AlarmClock.ACTION_SET_ALARM)
            .putExtra(AlarmClock.EXTRA_HOUR, hour.toDoubleOrNull()?.toInt() ?: return fail("Bad hour"))
            .putExtra(AlarmClock.EXTRA_MINUTES, minute.toDoubleOrNull()?.toInt() ?: 0)
            .putExtra(AlarmClock.EXTRA_MESSAGE, label)
            .putExtra(AlarmClock.EXTRA_SKIP_UI, true)
        if (repeat.isNotEmpty()) intent.putIntegerArrayListExtra(AlarmClock.EXTRA_DAYS, repeat)
        return if (start(intent)) ok("time" to "%02d:%02d".format(hour.toDouble().toInt(), minute.toDoubleOrNull()?.toInt() ?: 0)) else fail("No clock app")
    }

    @JavascriptInterface
    fun scheduleReminder(atMillis: String, text: String): String {
        val at = atMillis.toLongOrNull() ?: return fail("Bad time")
        val am = ctx.getSystemService(AlarmManager::class.java)
        val pi = PendingIntent.getBroadcast(
            ctx, (at xor text.hashCode().toLong()).toInt(),
            Intent(ctx, ReminderReceiver::class.java).putExtra("text", text),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val exact = Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms()
        if (exact) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
        else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
        return ok("exact" to exact)
    }

    @JavascriptInterface fun notify(title: String, body: String) { Notifications.alert(ctx, title, body) }

    // ================================================================== device controls

    @JavascriptInterface
    fun torch(on: String): String {
        val want = on == "true"
        return try {
            val cm = ctx.getSystemService(CameraManager::class.java)
            val id = cm.cameraIdList.firstOrNull {
                cm.getCameraCharacteristics(it).get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
            } ?: return fail("This phone has no flashlight")
            cm.setTorchMode(id, want)
            torchOn = want
            ok("flashlight" to if (want) "on" else "off")
        } catch (e: Exception) {
            fail("Flashlight busy (is the camera open?)")
        }
    }

    @JavascriptInterface
    fun media(action: String): String {
        val code = when (action) {
            "play" -> KeyEvent.KEYCODE_MEDIA_PLAY
            "pause" -> KeyEvent.KEYCODE_MEDIA_PAUSE
            "next" -> KeyEvent.KEYCODE_MEDIA_NEXT
            "previous" -> KeyEvent.KEYCODE_MEDIA_PREVIOUS
            "stop" -> KeyEvent.KEYCODE_MEDIA_STOP
            else -> KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE
        }
        val am = ctx.getSystemService(AudioManager::class.java)
        val now = SystemClock.uptimeMillis()
        am.dispatchMediaKeyEvent(KeyEvent(now, now, KeyEvent.ACTION_DOWN, code, 0))
        am.dispatchMediaKeyEvent(KeyEvent(now, now, KeyEvent.ACTION_UP, code, 0))
        return ok("action" to action)
    }

    @JavascriptInterface
    fun volume(action: String, level: String, stream: String): String {
        val am = ctx.getSystemService(AudioManager::class.java)
        val s = when (stream) {
            "ring" -> AudioManager.STREAM_RING
            "alarm" -> AudioManager.STREAM_ALARM
            "notification" -> AudioManager.STREAM_NOTIFICATION
            else -> AudioManager.STREAM_MUSIC
        }
        return try {
            val max = am.getStreamMaxVolume(s)
            when (action) {
                "set" -> am.setStreamVolume(s, ((level.toDoubleOrNull() ?: 50.0) / 100.0 * max).toInt().coerceIn(0, max), AudioManager.FLAG_SHOW_UI)
                "up" -> repeat(2) { am.adjustStreamVolume(s, AudioManager.ADJUST_RAISE, AudioManager.FLAG_SHOW_UI) }
                "down" -> repeat(2) { am.adjustStreamVolume(s, AudioManager.ADJUST_LOWER, AudioManager.FLAG_SHOW_UI) }
                "mute" -> am.adjustStreamVolume(s, AudioManager.ADJUST_MUTE, AudioManager.FLAG_SHOW_UI)
                "unmute" -> am.adjustStreamVolume(s, AudioManager.ADJUST_UNMUTE, AudioManager.FLAG_SHOW_UI)
            }
            ok("stream" to stream, "percent" to (am.getStreamVolume(s) * 100 / max.coerceAtLeast(1)))
        } catch (e: SecurityException) {
            fail("Do Not Disturb is blocking volume changes")
        }
    }

    @JavascriptInterface
    fun vibrate(ms: String) {
        val v = ctx.getSystemService(Vibrator::class.java)
        v?.vibrate(VibrationEffect.createOneShot((ms.toLongOrNull() ?: 800L).coerceIn(50, 10_000), VibrationEffect.DEFAULT_AMPLITUDE))
    }

    @JavascriptInterface
    fun copy(text: String) = main.post {
        ctx.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("Jarvis", text))
    }

    @JavascriptInterface
    fun deviceStatus(): String {
        val bm = ctx.getSystemService(BatteryManager::class.java)
        val cm = ctx.getSystemService(ConnectivityManager::class.java)
        val caps = cm.getNetworkCapabilities(cm.activeNetwork)
        val net = when {
            caps == null -> "offline"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "mobile data"
            else -> "online"
        }
        val am = ctx.getSystemService(AudioManager::class.java)
        val ringer = when (am.ringerMode) {
            AudioManager.RINGER_MODE_SILENT -> "silent"
            AudioManager.RINGER_MODE_VIBRATE -> "vibrate"
            else -> "normal"
        }
        return JSONObject()
            .put("battery_pct", bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY))
            .put("charging", bm.isCharging)
            .put("network", net)
            .put("ringer", ringer)
            .put("flashlight", if (torchOn) "on" else "off")
            .put("device", "${Build.MANUFACTURER} ${Build.MODEL}, Android ${Build.VERSION.RELEASE}")
            .toString()
    }

    // ================================================================== bubble + permissions

    @JavascriptInterface fun setExpanded(expanded: Boolean) { bubble?.setExpanded(expanded) }

    /** Called by the full app whenever settings change, so the bubble picks them up. */
    @JavascriptInterface fun settingsChanged() { if (bubble == null) BubbleService.instance?.reloadSoon() }

    @JavascriptInterface
    fun bubbleState(): String = JSONObject()
        .put("running", BubbleService.instance != null)
        .put("onBoot", Prefs.startOnBoot(ctx))
        .put("overlay", Settings.canDrawOverlays(ctx))
        .put("mic", has(Manifest.permission.RECORD_AUDIO))
        .toString()

    @JavascriptInterface
    fun startBubble(): String {
        if (!Settings.canDrawOverlays(ctx)) {
            start(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${ctx.packageName}")))
            return JSONObject().put("ok", false)
                .put("reason", "Turn on \"Display over other apps\" for Jarvis, then come back and tap Start bubble again.")
                .toString()
        }
        val intent = Intent(ctx, BubbleService::class.java)
        if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(intent) else ctx.startService(intent)
        Prefs.setBubbleWanted(ctx, true)
        return ok()
    }

    @JavascriptInterface
    fun stopBubble() {
        Prefs.setBubbleWanted(ctx, false)
        ctx.startService(Intent(ctx, BubbleService::class.java).setAction(BubbleService.ACTION_STOP))
    }

    @JavascriptInterface fun setStartOnBoot(on: String) { Prefs.setStartOnBoot(ctx, on == "true") }

    @JavascriptInterface
    fun requestPermissions() = main.post { permissionSteps(askRuntime = true) }

    /** Walks through: runtime permissions → draw over apps → exact alarms. */
    fun permissionSteps(askRuntime: Boolean) {
        val act = activity ?: return
        val perms = mutableListOf(
            Manifest.permission.RECORD_AUDIO,
            Manifest.permission.READ_CONTACTS,
            Manifest.permission.CALL_PHONE,
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
        )
        if (Build.VERSION.SDK_INT >= 33) perms += Manifest.permission.POST_NOTIFICATIONS
        val missing = perms.filter { !has(it) }
        if (askRuntime && missing.isNotEmpty()) {
            act.requestPermissions(missing.toTypedArray(), 42)
        } else if (!Settings.canDrawOverlays(ctx)) {
            start(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${ctx.packageName}")))
        } else if (Build.VERSION.SDK_INT >= 31 && !ctx.getSystemService(AlarmManager::class.java).canScheduleExactAlarms()) {
            start(Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:${ctx.packageName}")))
        } else if (missing.isEmpty()) {
            js("alert('All permissions granted ✓')")
        }
    }

    @SuppressLint("BatteryLife")
    @JavascriptInterface
    fun requestBackground() {
        val pm = ctx.getSystemService(PowerManager::class.java)
        if (!pm.isIgnoringBatteryOptimizations(ctx.packageName)) {
            start(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${ctx.packageName}")))
        } else {
            start(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${ctx.packageName}")))
        }
    }
}
