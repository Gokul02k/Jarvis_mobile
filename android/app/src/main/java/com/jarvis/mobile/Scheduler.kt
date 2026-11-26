package com.jarvis.mobile

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject
import java.util.Calendar

/**
 * Runs Jarvis commands at set times (the morning briefing, your scheduled commands).
 * Each schedule: { id, command, label, hour, minute, days: [Calendar.SUNDAY..SATURDAY] (empty = every day) }.
 */
object Scheduler {
    private fun prefs(ctx: Context) = ctx.getSharedPreferences("jarvis", Context.MODE_PRIVATE)

    fun list(ctx: Context): List<JSONObject> = try {
        val arr = JSONArray(prefs(ctx).getString("schedules", "[]"))
        (0 until arr.length()).map { arr.getJSONObject(it) }
    } catch (e: Exception) { emptyList() }

    /** Replaces all schedules (called by the app whenever settings change). */
    fun set(ctx: Context, json: String) {
        list(ctx).forEach { cancel(ctx, it.optString("id")) }
        prefs(ctx).edit().putString("schedules", json).apply()
        scheduleAll(ctx)
    }

    fun scheduleAll(ctx: Context) = list(ctx).forEach { scheduleNext(ctx, it) }

    private fun intent(ctx: Context, id: String, flags: Int): PendingIntent? = PendingIntent.getBroadcast(
        ctx, 7000 + (id.hashCode() and 0xffff),
        Intent(ctx, ScheduleReceiver::class.java).setAction("com.jarvis.mobile.SCHEDULE.$id").putExtra("id", id),
        flags or PendingIntent.FLAG_IMMUTABLE,
    )

    private fun cancel(ctx: Context, id: String) {
        intent(ctx, id, PendingIntent.FLAG_NO_CREATE)?.let { ctx.getSystemService(AlarmManager::class.java).cancel(it) }
    }

    private fun scheduleNext(ctx: Context, s: JSONObject) {
        val days = s.optJSONArray("days")?.let { a -> (0 until a.length()).map { a.getInt(it) }.toSet() }.orEmpty()
        val at = Calendar.getInstance().apply {
            set(Calendar.HOUR_OF_DAY, s.optInt("hour", 7)); set(Calendar.MINUTE, s.optInt("minute", 0))
            set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
            if (timeInMillis <= System.currentTimeMillis() + 1000) add(Calendar.DAY_OF_YEAR, 1)
            var guard = 0
            while (days.isNotEmpty() && get(Calendar.DAY_OF_WEEK) !in days && guard++ < 8) add(Calendar.DAY_OF_YEAR, 1)
        }.timeInMillis
        val pi = intent(ctx, s.optString("id"), PendingIntent.FLAG_UPDATE_CURRENT) ?: return
        val am = ctx.getSystemService(AlarmManager::class.java)
        if (Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms()) am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
        else am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
    }

    fun fire(ctx: Context, id: String) {
        val s = list(ctx).firstOrNull { it.optString("id") == id } ?: return
        scheduleNext(ctx, s)
        val command = s.optString("command")
        val label = s.optString("label").ifBlank { command }
        val bubble = BubbleService.instance
        if (bubble != null) bubble.runCommand(command)
        else Notifications.runPrompt(ctx, id, label, command)
    }
}

class ScheduleReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        Scheduler.fire(ctx, intent.getStringExtra("id") ?: return)
    }
}
