package com.jarvis.mobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Fires reminders set with "remind me at …" even when Jarvis is closed. */
class ReminderReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val text = intent.getStringExtra("text") ?: "Reminder"
        Notifications.alert(ctx, "⏰ Reminder", text)
        BubbleService.instance?.alert("Reminder", text)
    }
}
