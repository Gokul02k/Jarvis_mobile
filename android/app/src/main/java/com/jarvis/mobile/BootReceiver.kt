package com.jarvis.mobile

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.provider.Settings

/**
 * Brings the floating bubble back after the phone restarts (if enabled in settings),
 * or after an in-app update if it was running when the update started.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val wanted = when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED -> Prefs.startOnBoot(ctx)
            Intent.ACTION_MY_PACKAGE_REPLACED -> Prefs.restartAfterUpdate(ctx).also { Prefs.setRestartAfterUpdate(ctx, false) }
            else -> false
        }
        if (!wanted || !Prefs.bubbleWanted(ctx) || !Settings.canDrawOverlays(ctx)) return
        try {
            ctx.startForegroundService(Intent(ctx, BubbleService::class.java))
        } catch (ignored: Exception) {}
    }
}
