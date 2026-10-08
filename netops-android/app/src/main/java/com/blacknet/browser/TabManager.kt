package com.blacknet.browser

import android.content.Context
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.FrameLayout
import com.blacknet.browser.policy.BrowserPolicy
import com.blacknet.browser.policy.Pages
import androidx.webkit.WebViewAssetLoader

// Owns the tab list and the one WebView that is on screen. Tabs keep their
// WebViews alive while hidden (state and scroll position survive a switch)
// and are destroyed on close so nothing keeps rendering off screen.

class TabManager(
    private val container: FrameLayout,
    private val context: Context,
    private val policy: BrowserPolicy,
    private val assetLoader: WebViewAssetLoader,
    private val listener: Listener,
) {

    interface Listener {
        fun onTabsChanged(manager: TabManager)
        fun onPageUpdated(manager: TabManager, tab: Tab)
        fun onPageStarted(manager: TabManager, tab: Tab)
        fun onBlockedUpdated(manager: TabManager, tab: Tab)
        fun onProgress(manager: TabManager, tab: Tab, percent: Int)
    }

    val tabs = mutableListOf<Tab>()
    var current: Tab? = null
        private set
    private var nextId = 1

    fun newTab() {
        val tab = createTab()
        select(tab)
        tab.webView.loadUrl(Pages.NEW_TAB)
        listener.onTabsChanged(this)
    }

    fun select(tab: Tab) {
        if (current === tab) return
        current?.let { detach(it) }
        tabs.add(tab)
        attach(tab)
        current = tab
        listener.onTabsChanged(this)
        dispatchPageUpdated(tab)
        dispatchBlocked(tab)
    }

    fun switchTo(tab: Tab) {
        if (current === tab) return
        val previous = current
        previous?.let { detach(it) }
        attach(tab)
        current = tab
        listener.onTabsChanged(this)
        dispatchPageUpdated(tab)
        dispatchBlocked(tab)
    }

    fun close(tab: Tab) {
        val index = tabs.indexOf(tab)
        if (index < 0) return
        tabs.removeAt(index)
        val wasCurrent = current === tab
        if (wasCurrent) detach(tab)
        tab.webView.stopLoading()
        tab.webView.destroy()
        if (tabs.isEmpty()) {
            val replacement = createTab()
            tabs.add(replacement)
            if (wasCurrent) {
                attach(replacement)
                current = replacement
                replacement.webView.loadUrl(Pages.NEW_TAB)
            }
        } else if (wasCurrent) {
            val next = tabs[minOf(index, tabs.size - 1)]
            attach(next)
            current = next
        }
        listener.onTabsChanged(this)
        current?.let {
            dispatchPageUpdated(it)
            dispatchBlocked(it)
        }
    }

    fun isOnRefusalPage(tab: Tab): Boolean {
        val url = tab.webView.url ?: return false
        return Pages.isRefusal(url)
    }

    fun displayAddress(tab: Tab): String {
        val url = tab.webView.url ?: return tab.refusedTarget ?: ""
        if (Pages.isRefusal(url)) return tab.refusedTarget ?: url
        if (url == Pages.NEW_TAB) return ""
        return url
    }

    fun displayTitle(tab: Tab): String {
        if (tab.title.isNotBlank()) return tab.title
        val url = tab.webView.url ?: return "New tab"
        if (url == Pages.NEW_TAB || Pages.isAsset(url)) return "New tab"
        return tab.webView.url ?: "New tab"
    }

    fun dispatchPageUpdated(tab: Tab) = listener.onPageUpdated(this, tab)

    fun dispatchPageStarted(tab: Tab) = listener.onPageStarted(this, tab)

    fun dispatchBlocked(tab: Tab) = listener.onBlockedUpdated(this, tab)

    fun dispatchProgress(tab: Tab, percent: Int) = listener.onProgress(this, tab, percent)

    private fun createTab(): Tab {
        val webView = WebView(context)
        val tab = Tab(nextId++, webView)
        configure(tab)
        return tab
    }

    private fun configure(tab: Tab) {
        val webView = tab.webView
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            setSupportMultipleWindows(false)
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
        }
        webView.webViewClient = BrowserWebViewClient(tab, policy, assetLoader, this)
        webView.webChromeClient = object : WebChromeClient() {
            override fun onReceivedTitle(view: WebView?, title: String?) {
                tab.title = title ?: ""
                dispatchPageUpdated(tab)
            }

            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                dispatchProgress(tab, newProgress)
            }
        }
    }

    private fun attach(tab: Tab) {
        val parent = tab.webView.parent
        if (parent is ViewGroup) parent.removeView(tab.webView)
        container.addView(
            tab.webView,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )
        tab.webView.visibility = android.view.View.VISIBLE
    }

    private fun detach(tab: Tab) {
        container.removeView(tab.webView)
    }
}
