package com.jarvis.mobile

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Context
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import org.json.JSONObject

/**
 * Voice-Access-style screen control: back / home / recents, scroll, tap by name, type, and read the screen.
 * The user turns it on in Settings → Accessibility → Jarvis screen control. Nothing is read or sent anywhere
 * unless a command asks for it.
 */
class ScreenService : AccessibilityService() {

    companion object {
        @Volatile var instance: ScreenService? = null

        fun isEnabled(ctx: Context): Boolean {
            val list = Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
            return list.split(':').any { it.startsWith("${ctx.packageName}/") }
        }

        private fun res(ok: Boolean, vararg kv: Pair<String, Any?>): String {
            val o = JSONObject().put("ok", ok)
            kv.forEach { (k, v) -> o.put(k, v) }
            return o.toString()
        }

        private val NOT_ON = res(false, "error" to "Screen control is off. Turn it on in Jarvis Settings → Commands.", "needsSetup" to true)

        fun global(name: String): String {
            val s = instance ?: return NOT_ON
            val action = when (name) {
                "back" -> GLOBAL_ACTION_BACK
                "home" -> GLOBAL_ACTION_HOME
                "recents" -> GLOBAL_ACTION_RECENTS
                "notifications" -> GLOBAL_ACTION_NOTIFICATIONS
                "quick_settings" -> GLOBAL_ACTION_QUICK_SETTINGS
                "power" -> GLOBAL_ACTION_POWER_DIALOG
                "lock" -> if (Build.VERSION.SDK_INT >= 28) GLOBAL_ACTION_LOCK_SCREEN else return res(false, "error" to "Needs Android 9")
                "screenshot" -> if (Build.VERSION.SDK_INT >= 28) GLOBAL_ACTION_TAKE_SCREENSHOT else return res(false, "error" to "Needs Android 9")
                else -> return res(false, "error" to "Unknown action $name")
            }
            return res(s.performGlobalAction(action), "action" to name)
        }

        fun read(maxChars: Int): String {
            val s = instance ?: return NOT_ON
            val root = s.targetRoot() ?: return res(false, "error" to "Nothing on screen to read.")
            val lines = LinkedHashSet<String>()
            s.collect(root, lines, 0)
            val text = lines.joinToString("\n").take(maxChars)
            return res(true, "app" to s.appLabel(root.packageName?.toString()), "text" to text, "truncated" to (text.length >= maxChars))
        }

        fun tap(target: String): String {
            val s = instance ?: return NOT_ON
            val root = s.targetRoot() ?: return res(false, "error" to "Nothing on screen.")
            val node = s.find(root, target) ?: return res(false, "error" to "I can't see \"$target\" on the screen.")
            val label = (node.text ?: node.contentDescription)?.toString() ?: target
            var n: AccessibilityNodeInfo? = node
            while (n != null && !n.isClickable) n = n.parent
            if (n != null && n.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return res(true, "tapped" to label)
            val r = Rect().also { node.getBoundsInScreen(it) }
            return res(s.gesture(r.exactCenterX(), r.exactCenterY(), r.exactCenterX(), r.exactCenterY(), 60), "tapped" to label)
        }

        fun scroll(direction: String): String {
            val s = instance ?: return NOT_ON
            val root = s.targetRoot() ?: return res(false, "error" to "Nothing on screen.")
            val horizontal = direction == "left" || direction == "right"
            val forward = direction == "down" || direction == "right"
            val node = s.biggestScrollable(root)
            if (node != null && !horizontal &&
                node.performAction(if (forward) AccessibilityNodeInfo.ACTION_SCROLL_FORWARD else AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD)
            ) return res(true, "scrolled" to direction)
            // Fallback: swipe across the middle of the screen.
            val m = s.resources.displayMetrics
            val w = m.widthPixels.toFloat(); val h = m.heightPixels.toFloat()
            val ok = when (direction) {
                "down" -> s.gesture(w / 2, h * 0.7f, w / 2, h * 0.3f, 300)
                "up" -> s.gesture(w / 2, h * 0.3f, w / 2, h * 0.7f, 300)
                "right" -> s.gesture(w * 0.8f, h / 2, w * 0.2f, h / 2, 300)
                else -> s.gesture(w * 0.2f, h / 2, w * 0.8f, h / 2, 300)
            }
            return res(ok, "scrolled" to direction)
        }

        fun type(text: String): String {
            val s = instance ?: return NOT_ON
            val root = s.targetRoot() ?: return res(false, "error" to "Nothing on screen.")
            val field = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)?.takeIf { it.isEditable }
                ?: s.firstEditable(root)
                ?: return res(false, "error" to "There's no text box on the screen.")
            val before = if (field.isShowingHintTextCompat()) "" else field.text?.toString().orEmpty()
            val joined = if (before.isEmpty()) text else "$before ${text}"
            val args = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, joined) }
            field.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
            return res(field.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args), "typed" to text)
        }

        private fun AccessibilityNodeInfo.isShowingHintTextCompat() =
            Build.VERSION.SDK_INT >= 26 && isShowingHintText
    }

    override fun onServiceConnected() { instance = this }
    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onInterrupt() {}
    override fun onDestroy() { instance = null; super.onDestroy() }
    override fun onUnbind(intent: android.content.Intent?): Boolean { instance = null; return super.onUnbind(intent) }

    /** The app the user is looking at, skipping Jarvis's own bubble / app window. */
    private fun targetRoot(): AccessibilityNodeInfo? {
        val own = packageName
        val all: List<AccessibilityWindowInfo> = try { windows } catch (e: Exception) { emptyList() }
        val apps = all
            .filter { it.type == AccessibilityWindowInfo.TYPE_APPLICATION }
            .mapNotNull { it.root }
            .filter { it.packageName?.toString() != own }
        return apps.firstOrNull() ?: rootInActiveWindow?.takeIf { it.packageName?.toString() != own }
    }

    private fun collect(n: AccessibilityNodeInfo?, out: MutableSet<String>, depth: Int) {
        if (n == null || depth > 40 || out.size > 400) return
        if (n.isVisibleToUser) {
            val t = (n.text ?: n.contentDescription)?.toString()?.trim()
            if (!t.isNullOrEmpty() && t.length > 1) out.add(t.replace(Regex("\\s+"), " "))
        }
        for (i in 0 until n.childCount) collect(n.getChild(i), out, depth + 1)
    }

    private fun find(root: AccessibilityNodeInfo, target: String): AccessibilityNodeInfo? {
        val q = target.trim().lowercase()
        val all = mutableListOf<AccessibilityNodeInfo>()
        fun walk(n: AccessibilityNodeInfo?, d: Int) {
            if (n == null || d > 40) return
            if (n.isVisibleToUser) all.add(n)
            for (i in 0 until n.childCount) walk(n.getChild(i), d + 1)
        }
        walk(root, 0)
        fun label(n: AccessibilityNodeInfo) = ((n.text ?: n.contentDescription)?.toString() ?: "").trim().lowercase()
        return all.firstOrNull { label(it) == q }
            ?: all.firstOrNull { label(it).startsWith(q) }
            ?: all.firstOrNull { label(it).contains(q) && q.length >= 3 }
    }

    private fun biggestScrollable(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        var best: AccessibilityNodeInfo? = null
        var bestArea = 0
        fun walk(n: AccessibilityNodeInfo?, d: Int) {
            if (n == null || d > 40) return
            if (n.isScrollable && n.isVisibleToUser) {
                val r = Rect().also { n.getBoundsInScreen(it) }
                val area = r.width() * r.height()
                if (area > bestArea) { bestArea = area; best = n }
            }
            for (i in 0 until n.childCount) walk(n.getChild(i), d + 1)
        }
        walk(root, 0)
        return best
    }

    private fun firstEditable(root: AccessibilityNodeInfo): AccessibilityNodeInfo? {
        if (root.isEditable && root.isVisibleToUser) return root
        for (i in 0 until root.childCount) firstEditable(root.getChild(i) ?: continue)?.let { return it }
        return null
    }

    private fun gesture(x1: Float, y1: Float, x2: Float, y2: Float, ms: Long): Boolean {
        val path = Path().apply { moveTo(x1, y1); lineTo(x2, y2) }
        val g = GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(path, 0, ms)).build()
        return dispatchGesture(g, null, null)
    }

    private fun appLabel(pkg: String?): String {
        if (pkg == null) return ""
        return try {
            packageManager.getApplicationLabel(packageManager.getApplicationInfo(pkg, 0)).toString()
        } catch (e: Exception) { pkg }
    }
}
