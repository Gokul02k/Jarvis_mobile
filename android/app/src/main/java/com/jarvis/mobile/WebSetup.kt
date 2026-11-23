package com.jarvis.mobile

import android.annotation.SuppressLint
import android.graphics.Color
import android.webkit.GeolocationPermissions
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader

/** Loads the bundled Jarvis web app (assets = ../../web) into a WebView with the native bridge. */
object WebSetup {
    private const val HOST = "appassets.androidplatform.net"
    const val ORIGIN = "https://$HOST"

    @SuppressLint("SetJavaScriptEnabled")
    fun configure(web: WebView, bridge: JarvisBridge, bubble: Boolean, onReady: () -> Unit = {}) {
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(web.context))
            .build()

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            setGeolocationEnabled(true)
            allowFileAccess = false
            allowContentAccess = false
        }
        if (bubble) {
            web.setBackgroundColor(Color.TRANSPARENT)
            web.isVerticalScrollBarEnabled = false
            web.isHorizontalScrollBarEnabled = false
            web.overScrollMode = WebView.OVER_SCROLL_NEVER
        } else {
            web.setBackgroundColor(Color.parseColor("#05080D"))
        }

        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                loader.shouldInterceptRequest(request.url)

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == HOST) return false
                bridge.openUrl(request.url.toString()) // links, tel:, sms:, intent: → real apps
                return true
            }

            override fun onPageFinished(view: WebView, url: String) = onReady()
        }

        web.webChromeClient = object : WebChromeClient() {
            override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
                callback.invoke(origin, origin.contains(HOST), false)
            }

            override fun onPermissionRequest(request: PermissionRequest) {
                if (request.origin.host == HOST) request.grant(request.resources) else request.deny()
            }
        }

        web.addJavascriptInterface(bridge, "JarvisNative")
        web.loadUrl("$ORIGIN/assets/index.html" + if (bubble) "?bubble=1" else "")
    }
}
