package com.blacknet.browser.policy

// The whole decision, in the desktop shell's order: a hidden-service address
// is refused before anything else looks at it, then the URL is normalised,
// then loopback and IPv6 literals get their exemptions, then the host policy
// and the tracker rules speak. One function, so the omnibox, link clicks and
// the WebView request hooks can never disagree about what loads.

data class BrowserPolicy(
    val blockPrivateHosts: Boolean = true,
    val blocklist: Blocklist = Blocklist(),
    val searchUrl: String = "https://duckduckgo.com/?q=%s",
) {

    enum class Kind { Onion, Parse, HostPolicy, Tracker }

    sealed class Verdict {
        data class Allowed(val normalised: NormalisedUrl) : Verdict()
        data class Refused(val kind: Kind, val reason: String) : Verdict()
    }

    fun verdict(raw: String): Verdict {
        val onion = Onion.onionHost(raw)
        if (onion != null) {
            return Verdict.Refused(Kind.Onion, "onion address: $onion")
        }

        val normalised = try {
            Url.normalise(raw)
        } catch (e: UrlException) {
            return Verdict.Refused(Kind.Parse, "url policy: ${e.message}")
        }

        // Loopback is allowed even though the host policy blocks private
        // ranges by default: the proxy gateway the shell supervises lives
        // there, and blocking it would break the IP rotator from inside the
        // browser that is using it.
        if (normalised.host == "127.0.0.1" || normalised.host == "localhost" ||
            normalised.host == "::1"
        ) {
            return Verdict.Allowed(normalised)
        }
        if (normalised.host.startsWith("[")) return Verdict.Allowed(normalised)

        if (blockPrivateHosts) {
            try {
                Url.validateHostname(normalised.host)
            } catch (e: UrlException) {
                return Verdict.Refused(Kind.HostPolicy, "host policy: ${e.message}")
            }
        }

        val tracker = blocklist.check(normalised.url)
        if (tracker.blocked) {
            return Verdict.Refused(
                Kind.Tracker,
                "tracker rule ${tracker.pattern} (${tracker.source})",
            )
        }
        return Verdict.Allowed(normalised)
    }

    fun looksLikeUrl(text: String): Boolean {
        if (text.any { it == ' ' || it == '\t' }) return false
        if (text.startsWith("localhost")) return true
        if (text.contains('.') && !text.startsWith(".")) return true
        if (text.contains(':') && !text.contains('/')) return true
        return false
    }

    fun targetFor(input: String): String {
        val text = input.trim()
        return if (looksLikeUrl(text)) text else searchUrl.replace("%s", encodeQuery(text))
    }

    private fun encodeQuery(text: String): String =
        java.net.URLEncoder.encode(text, "UTF-8")
}
