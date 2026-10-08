package com.blacknet.browser.history

import com.blacknet.browser.policy.BrowserPolicy
import com.blacknet.browser.policy.Pages
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

// The two halves of a visit that do not need a database: whether a URL
// deserves to be remembered at all, and how an age reads. Refused targets
// (hidden-service addresses, private ranges, tracker URLs) never finished
// loading, so they are not visits and never reach the store.

object History {

    fun shouldRecord(policy: BrowserPolicy, url: String?): Boolean {
        if (url.isNullOrEmpty()) return false
        if (!url.startsWith("http://") && !url.startsWith("https://")) return false
        if (Pages.isAsset(url)) return false
        return policy.verdict(url) is BrowserPolicy.Verdict.Allowed
    }

    fun relTime(now: Long, ts: Long): String {
        val seconds = ((now - ts) / 1000).coerceAtLeast(0)
        return when {
            seconds < 60 -> "just now"
            seconds < 3600 -> "${seconds / 60}m ago"
            seconds < 86_400 -> "${seconds / 3600}h ago"
            seconds < 7 * 86_400 -> "${seconds / 86_400}d ago"
            else -> SimpleDateFormat("MMM d, yyyy", Locale.ENGLISH).format(Date(ts))
        }
    }
}
