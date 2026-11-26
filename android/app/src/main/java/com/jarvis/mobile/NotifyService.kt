package com.jarvis.mobile

import android.app.Notification
import android.app.RemoteInput
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import org.json.JSONArray
import org.json.JSONObject

/**
 * Lets Jarvis read your notifications aloud, summarise them (only when you ask) and reply to messages.
 * Nothing is stored: Jarvis looks at the notifications currently in the shade when a command asks for them.
 */
class NotifyService : NotificationListenerService() {

    companion object {
        @Volatile var instance: NotifyService? = null

        fun isEnabled(ctx: Context): Boolean {
            val flat = Settings.Secure.getString(ctx.contentResolver, "enabled_notification_listeners") ?: return false
            return flat.split(':').any { it.startsWith("${ctx.packageName}/") }
        }

        fun settingsIntent(ctx: Context): Intent =
            if (Build.VERSION.SDK_INT >= 30)
                Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS)
                    .putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, ComponentName(ctx, NotifyService::class.java).flattenToString())
            else Intent("android.settings.ACTION_NOTIFICATION_LISTENER_SETTINGS")

        private val NOT_ON = JSONObject().put("ok", false).put("needsSetup", true)
            .put("error", "Notification access is off. Turn it on in Jarvis Settings → Commands.").toString()

        fun list(max: Int): String {
            val s = instance ?: return NOT_ON
            val arr = JSONArray()
            s.readable().take(max).forEach { (sbn, n) ->
                arr.put(JSONObject()
                    .put("app", n.app).put("from", n.title).put("text", n.text)
                    .put("minutes_ago", ((System.currentTimeMillis() - sbn.postTime) / 60000).toInt())
                    .put("can_reply", s.replyAction(sbn) != null))
            }
            return JSONObject().put("ok", true).put("count", arr.length()).put("notifications", arr).toString()
        }

        fun reply(to: String, message: String): String {
            val s = instance ?: return NOT_ON
            val q = to.trim().lowercase()
            val hit = s.readable().firstOrNull { (sbn, n) ->
                (n.title.lowercase().contains(q) || n.app.lowercase() == q) && s.replyAction(sbn) != null
            } ?: return JSONObject().put("ok", false)
                .put("error", "I can't find a message from $to that I can reply to.").toString()
            val action = s.replyAction(hit.first)!!
            return try {
                val intent = Intent()
                val results = Bundle()
                action.remoteInputs.forEach { results.putCharSequence(it.resultKey, message) }
                RemoteInput.addResultsToIntent(action.remoteInputs, intent, results)
                action.actionIntent.send(s, 0, intent)
                JSONObject().put("ok", true).put("to", hit.second.title).put("app", hit.second.app).toString()
            } catch (e: Exception) {
                JSONObject().put("ok", false).put("error", "The reply couldn't be sent: ${e.message}").toString()
            }
        }
    }

    private data class Info(val app: String, val title: String, val text: String)

    override fun onListenerConnected() { instance = this }
    override fun onListenerDisconnected() { if (instance === this) instance = null }
    override fun onDestroy() { if (instance === this) instance = null; super.onDestroy() }

    /** Newest first, skipping Jarvis itself, system noise, ongoing ones (music, downloads) and group summaries. */
    private fun readable(): List<Pair<StatusBarNotification, Info>> {
        val all = try { activeNotifications?.toList().orEmpty() } catch (e: Exception) { emptyList() }
        return all
            .filter { it.packageName != packageName && it.packageName != "android" && it.packageName != "com.android.systemui" }
            .filter { !it.isOngoing && (it.notification.flags and Notification.FLAG_GROUP_SUMMARY) == 0 }
            .sortedByDescending { it.postTime }
            .mapNotNull { sbn -> info(sbn)?.let { sbn to it } }
    }

    private fun info(sbn: StatusBarNotification): Info? {
        val e = sbn.notification.extras
        val title = (e.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE) ?: e.getCharSequence(Notification.EXTRA_TITLE))?.toString()?.trim().orEmpty()
        // Chat apps: the last few messages of the conversation.
        val messages = (e.getParcelableArray(Notification.EXTRA_MESSAGES) ?: emptyArray())
            .mapNotNull { (it as? Bundle)?.getCharSequence("text")?.toString() }
            .takeLast(3)
        val text = when {
            messages.isNotEmpty() -> messages.joinToString(" / ")
            else -> (e.getCharSequence(Notification.EXTRA_BIG_TEXT) ?: e.getCharSequence(Notification.EXTRA_TEXT))?.toString().orEmpty()
        }.replace(Regex("\\s+"), " ").trim().take(300)
        if (title.isEmpty() && text.isEmpty()) return null
        return Info(appLabel(sbn.packageName), title, text)
    }

    private fun replyAction(sbn: StatusBarNotification): Notification.Action? =
        sbn.notification.actions?.firstOrNull { a -> a.remoteInputs?.any { it.allowFreeFormInput } == true }

    private fun appLabel(pkg: String): String = try {
        packageManager.getApplicationLabel(packageManager.getApplicationInfo(pkg, 0)).toString()
    } catch (e: Exception) { pkg }
}
