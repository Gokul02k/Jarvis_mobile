package com.jarvis.mobile

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import androidx.core.app.NotificationCompat

object Notifications {
    private const val CH_BUBBLE = "bubble"
    private const val CH_ALERTS = "alerts"

    private fun channels(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CH_BUBBLE, "Floating Jarvis", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Keeps Jarvis running in the background"
                setShowBadge(false)
            }
        )
        nm.createNotificationChannel(
            NotificationChannel(CH_ALERTS, "Reminders & timers", NotificationManager.IMPORTANCE_HIGH).apply {
                description = "Reminders and alerts from Jarvis"
                enableVibration(true)
            }
        )
    }

    private fun openApp(ctx: Context) = PendingIntent.getActivity(
        ctx, 0, Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun serviceAction(ctx: Context, action: String, code: Int) = PendingIntent.getService(
        ctx, code, Intent(ctx, BubbleService::class.java).setAction(action),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    fun bubble(ctx: Context): Notification {
        channels(ctx)
        return NotificationCompat.Builder(ctx, CH_BUBBLE)
            .setSmallIcon(R.drawable.ic_stat_jarvis)
            .setContentTitle("Jarvis is on standby")
            .setContentText("Tap the bubble or say \"Jarvis\"")
            .setOngoing(true)
            .setSilent(true)
            .setContentIntent(openApp(ctx))
            .addAction(0, "Talk", serviceAction(ctx, BubbleService.ACTION_TALK, 1))
            .addAction(0, "Close bubble", serviceAction(ctx, BubbleService.ACTION_STOP, 2))
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    fun alert(ctx: Context, title: String, body: String) {
        channels(ctx)
        if (ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED &&
            android.os.Build.VERSION.SDK_INT >= 33
        ) return
        val n = NotificationCompat.Builder(ctx, CH_ALERTS)
            .setSmallIcon(R.drawable.ic_stat_jarvis)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setAutoCancel(true)
            .setContentIntent(openApp(ctx))
            .build()
        ctx.getSystemService(NotificationManager::class.java).notify((System.currentTimeMillis() % 100000).toInt(), n)
    }
}
