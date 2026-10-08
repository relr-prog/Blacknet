package com.blacknet.browser

import android.graphics.Bitmap
import android.net.Uri
import android.net.http.SslError
import android.view.View
import android.webkit.SslErrorHandler
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import com.blacknet.browser.policy.BrowserPolicy
import com.blacknet.browser.policy.Pages
import org.json.JSONObject
import java.io.ByteArrayInputStream

// Every request passes two doors: this client decides whole navigations
// (refusals become the shell's own explanation page) and shouldInterceptRequest
// decides resources (trackers get an empty 200 and are counted per tab,
// policy refusals get the same silence without the count). One client per
// tab, so the counters can never land on the wrong tab.

class BrowserWebViewClient(
    private val tab: Tab,
    private val policy: BrowserPolicy,
    private val assetLoader: androidx.webkit.WebViewAssetLoader,
    private val manager: TabManager,
) : WebViewClient() {

    override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val url = request.url.toString()
        if (Pages.isAsset(url)) return false
        return when (val verdict = policy.verdict(url)) {
            is BrowserPolicy.Verdict.Allowed -> false
            is BrowserPolicy.Verdict.Refused -> {
                refuse(view, url, replace = manager.isOnRefusalPage(tab))
                true
            }
        }
    }

    override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
        assetLoader.shouldInterceptRequest(request.url)?.let { return it }
        val scheme = request.url.scheme?.lowercase()
        if (scheme != "http" && scheme != "https") return null
        return when (val verdict = policy.verdict(request.url.toString())) {
            is BrowserPolicy.Verdict.Allowed -> null
            is BrowserPolicy.Verdict.Refused -> {
                if (verdict.kind == BrowserPolicy.Kind.Tracker) {
                    tab.blocked++
                    manager.dispatchBlocked(tab)
                }
                emptyResponse()
            }
        }
    }

    override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
        if (url != null && Pages.isAsset(url)) {
            if (Pages.isRefusal(url)) {
                tab.refusedTarget = Pages.refusalTargetOf(url)
            } else if (url == Pages.NEW_TAB) {
                tab.refusedTarget = null
            }
            manager.dispatchPageStarted(tab)
            return
        }
        if (url == null) {
            manager.dispatchPageStarted(tab)
            return
        }
        when (policy.verdict(url)) {
            is BrowserPolicy.Verdict.Refused -> refuse(view, url, replace = true)
            is BrowserPolicy.Verdict.Allowed -> {
                tab.refusedTarget = null
                manager.dispatchPageStarted(tab)
            }
        }
    }

    override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
        manager.dispatchPageUpdated(tab)
    }

    override fun onReceivedError(
        view: WebView,
        request: WebResourceRequest,
        error: WebResourceError,
    ) {
        if (request.isForMainFrame) manager.dispatchPageUpdated(tab)
    }

    override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
        // A certificate that does not check out is not a warning to dismiss
        // silently and not a page to load: the request stops here.
        handler.cancel()
        manager.dispatchPageUpdated(tab)
    }

    private fun refuse(view: WebView, target: String, replace: Boolean) {
        tab.refusedTarget = target
        val refusalUrl = Pages.refusal(target)
        if (replace) {
            val script = "window.location.replace(" + JSONObject.quote(refusalUrl) + ")"
            view.evaluateJavascript(script, null)
        } else {
            view.loadUrl(refusalUrl)
        }
        manager.dispatchPageUpdated(tab)
    }

    private fun emptyResponse(): WebResourceResponse =
        WebResourceResponse("text/plain", "UTF-8", ByteArrayInputStream(ByteArray(0)))
}
