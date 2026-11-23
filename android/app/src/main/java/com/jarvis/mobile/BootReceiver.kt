package com.jarvis.mobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Settings

/** Brings the floating bubble back after the phone restarts (if enabled in settings). */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        if (!Prefs.startOnBoot(ctx) || !Prefs.bubbleWanted(ctx) || !Settings.canDrawOverlays(ctx)) return
        try {
            ctx.startForegroundService(Intent(ctx, BubbleService::class.java))
        } catch (ignored: Exception) {}
    }
}
