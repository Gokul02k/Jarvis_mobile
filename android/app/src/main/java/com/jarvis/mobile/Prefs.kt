package com.jarvis.mobile

import android.content.Context

object Prefs {
    private fun p(ctx: Context) = ctx.getSharedPreferences("jarvis", Context.MODE_PRIVATE)

    fun startOnBoot(ctx: Context) = p(ctx).getBoolean("boot", false)
    fun setStartOnBoot(ctx: Context, on: Boolean) = p(ctx).edit().putBoolean("boot", on).apply()

    fun bubbleWanted(ctx: Context) = p(ctx).getBoolean("bubble", false)
    fun setBubbleWanted(ctx: Context, on: Boolean) = p(ctx).edit().putBoolean("bubble", on).apply()

    /** (onRight, y) */
    fun bubblePos(ctx: Context): Pair<Boolean, Int>? {
        val y = p(ctx).getInt("y", -1)
        return if (y < 0) null else p(ctx).getBoolean("right", true) to y
    }
    fun setBubblePos(ctx: Context, right: Boolean, y: Int) = p(ctx).edit().putBoolean("right", right).putInt("y", y).apply()
}
