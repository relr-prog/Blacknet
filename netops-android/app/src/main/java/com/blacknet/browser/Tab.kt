package com.blacknet.browser

import android.webkit.WebView

class Tab(val id: Int, val webView: WebView) {
    var title: String = ""
    var blocked: Int = 0
    var refusedTarget: String? = null
}
