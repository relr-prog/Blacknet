package com.blacknet.browser.policy

// The browser's own pages, served from the APK's assets through the
// WebViewAssetLoader under one fixed https host. Nothing on the public
// network can answer for that host: it only exists inside this process.

object Pages {
    const val HOST = "appassets.androidplatform.net"
    private const val BASE = "https://$HOST/assets/"

    const val NEW_TAB = BASE + "newtab.html"

    fun isAsset(url: String): Boolean = url.startsWith(BASE)

    fun isRefusal(url: String): Boolean = url.startsWith(BASE + "unreachable.html")

    fun refusal(target: String): String =
        BASE + "unreachable.html?url=" + java.net.URLEncoder.encode(target, "UTF-8")

    fun refusalTargetOf(assetUrl: String): String? {
        if (!assetUrl.startsWith(BASE + "unreachable.html")) return null
        val query = assetUrl.substringAfter('?', "")
        if (query.isEmpty()) return null
        for (pair in query.split('&')) {
            val eq = pair.indexOf('=')
            if (eq > 0 && pair.substring(0, eq) == "url") {
                return java.net.URLDecoder.decode(pair.substring(eq + 1), "UTF-8")
            }
        }
        return null
    }
}
