package com.jarvis.mobile

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * In-app updates for the sideloaded APK: download the latest build from GitHub Releases
 * and hand it to Android's installer. Same signing key, higher versionCode = installs over the top.
 */
object Updater {
    const val REPO = "Gokul02k/Jarvis_mobile"
    const val MANIFEST_URL = "https://github.com/$REPO/releases/download/latest/version.json"
    const val APK_URL = "https://github.com/$REPO/releases/download/latest/Jarvis.apk"

    fun currentVersionCode(ctx: Context): Long {
        val info = ctx.packageManager.getPackageInfo(ctx.packageName, 0)
        return if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else @Suppress("DEPRECATION") info.versionCode.toLong()
    }

    fun info(ctx: Context): JSONObject {
        val pkg = ctx.packageManager.getPackageInfo(ctx.packageName, 0)
        return JSONObject()
            .put("versionName", pkg.versionName ?: "")
            .put("versionCode", currentVersionCode(ctx))
            .put("sha", BuildConfig.GIT_SHA)
            .put("installedAt", pkg.lastUpdateTime)
            .put("manifestUrl", MANIFEST_URL)
            .put("canInstall", canInstall(ctx))
    }

    fun canInstall(ctx: Context) = Build.VERSION.SDK_INT < 26 || ctx.packageManager.canRequestPackageInstalls()

    /** Opens the "Install unknown apps" switch for Jarvis. */
    fun askInstallPermission(ctx: Context) {
        try {
            ctx.startActivity(
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${ctx.packageName}"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )
        } catch (ignored: Exception) {}
    }

    /**
     * Blocking: downloads [url] and launches the installer. Call off the main thread.
     * [progress] gets 0..100 (or -1 when the size is unknown).
     */
    fun downloadAndInstall(ctx: Context, url: String, progress: (Int) -> Unit): JSONObject {
        if (!canInstall(ctx)) {
            askInstallPermission(ctx)
            return JSONObject().put("ok", false).put("needsPermission", true)
        }
        val dir = File(ctx.cacheDir, "updates").apply { mkdirs() }
        dir.listFiles()?.forEach { it.delete() }
        val apk = File(dir, "Jarvis.apk")

        val conn = URL(url).openConnection() as HttpURLConnection
        conn.connectTimeout = 20_000
        conn.readTimeout = 60_000
        conn.instanceFollowRedirects = true
        try {
            val status = conn.responseCode
            if (status !in 200..299) return fail("Download failed (HTTP $status).")
            val total = conn.contentLengthLong
            var done = 0L
            var lastPct = -2
            conn.inputStream.use { input ->
                apk.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        done += n
                        val pct = if (total > 0) (done * 100 / total).toInt() else -1
                        if (pct != lastPct && (pct < 0 || pct - lastPct >= 2 || pct == 100)) {
                            lastPct = pct; progress(pct)
                        }
                    }
                }
            }
            if (total > 0 && done != total) return fail("Download was interrupted. Try again.")
        } finally {
            conn.disconnect()
        }

        // Make sure it really is a newer Jarvis before asking Android to install it.
        @Suppress("DEPRECATION")
        val archive = ctx.packageManager.getPackageArchiveInfo(apk.path, 0)
            ?: return fail("The downloaded file isn't a valid app. Try again later.")
        if (archive.packageName != ctx.packageName) return fail("The download isn't Jarvis.")
        val newCode = if (Build.VERSION.SDK_INT >= 28) archive.longVersionCode else @Suppress("DEPRECATION") archive.versionCode.toLong()
        if (newCode <= currentVersionCode(ctx)) return JSONObject().put("ok", false).put("upToDate", true)

        // Bring the bubble back once the new version is installed (see BootReceiver).
        Prefs.setRestartAfterUpdate(ctx, BubbleService.instance != null)

        val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.files", apk)
        ctx.startActivity(
            Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        )
        return JSONObject().put("ok", true).put("versionCode", newCode)
    }

    private fun fail(msg: String) = JSONObject().put("ok", false).put("error", msg)
}
