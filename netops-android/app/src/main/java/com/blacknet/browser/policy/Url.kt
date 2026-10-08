package com.blacknet.browser.policy

// URL admission control. The single place that decides what the browser is
// allowed to load, ported statement-for-statement from the desktop shell's
// native url.cpp so both builds refuse the same things for the same reasons.

data class UrlPolicy(
    val httpsOnly: Boolean = true,
    val maxUrlLength: Int = 2048,
    val maxDataUrlLength: Int = 8192,
    val allowDataHtml: Boolean = true,
)

data class NormalisedUrl(
    val url: String,
    val scheme: String,
    val host: String,
    val port: Int = 0,
    val path: String,
    val secure: Boolean,
)

class UrlException(message: String) : Exception(message)

object Url {

    private fun lower(value: String) = value.lowercase()

    private fun isSchemeChar(c: Char) = c.isLetterOrDigit() || c == '+' || c == '.' || c == '-'

    private fun schemeOf(url: String): String? {
        val colon = url.indexOf(':')
        if (colon <= 0) return null
        for (i in 0 until colon) {
            if (!isSchemeChar(url[i])) return null
        }
        if (!url[0].isLetter()) return null

        // "example.com:8080" is a host and a port, not a scheme, even though
        // dots are legal scheme characters. Only accept a scheme when the URL
        // is either "scheme://..." or an opaque scheme that is not followed by
        // digits.
        val tail = url.substring(colon + 1)
        val hierarchical = tail.startsWith("//")
        val opaque = tail.isNotEmpty() && !tail[0].isDigit()
        if (!hierarchical && !opaque) return null

        return lower(url.substring(0, colon))
    }

    private fun hasIllegalCharacters(url: String): Boolean {
        for (c in url) {
            if (c == ' ' || c == '\t' || c == '\r' || c == '\n' ||
                c == '<' || c == '>' || c == '"' || c == '\'' || c == '`'
            ) {
                return true
            }
        }
        return false
    }

    private fun parsePort(text: String): Int {
        if (text.isEmpty()) throw UrlException("invalid port")
        var value = 0
        for (c in text) {
            if (!c.isDigit()) throw UrlException("invalid port")
            value = value * 10 + (c - '0')
            if (value > 65535) throw UrlException("invalid port")
        }
        return value
    }

    private fun isIpv4Literal(host: String): Boolean {
        var dots = 0
        for (c in host) {
            if (c == '.') dots++
            else if (!c.isDigit()) return false
        }
        return dots == 3
    }

    private data class Authority(val host: String, val port: Int)

    private fun splitAuthority(authority: String): Authority {
        if (authority.isEmpty()) throw UrlException("URL has no host")
        if (authority[0] == '[') {
            val close = authority.indexOf(']')
            if (close < 0) throw UrlException("malformed IPv6 host")
            var port = 0
            if (close + 1 < authority.length) {
                if (authority[close + 1] != ':') throw UrlException("malformed IPv6 host")
                port = parsePort(authority.substring(close + 2))
            }
            return Authority(authority.substring(0, close + 1), port)
        }
        val colon = authority.lastIndexOf(':')
        if (colon >= 0) {
            val port = parsePort(authority.substring(colon + 1))
            return Authority(authority.substring(0, colon), port)
        }
        return Authority(authority, 0)
    }

    fun isLoopback(host: String): Boolean {
        val value = lower(host)
        return value == "localhost" || value.startsWith("127.") || value == "::1"
    }

    fun isPrivateIpv4(host: String): Boolean {
        if (!isIpv4Literal(host)) return false
        var a = 0
        var b = 0
        var octets = 0
        var index = 0
        var value = 0
        while (index <= host.length) {
            if (index == host.length || host[index] == '.') {
                if (value > 255) return false
                if (octets == 1) b = value
                if (octets == 0) a = value
                octets++
                value = 0
            } else {
                value = value * 10 + (host[index] - '0')
                if (value > 255) return false
            }
            index++
        }
        if (octets != 4) return false
        if (a == 10) return true
        if (a == 127) return true
        if (a == 0) return true
        if (a == 169 && b == 254) return true
        if (a == 172 && b >= 16 && b <= 31) return true
        if (a == 192 && b == 168) return true
        if (a == 100 && b >= 64 && b <= 127) return true
        return false
    }

    // Normalises user input into something safe to navigate to, or explains
    // the refusal. https-first by default: a bare host gets https://, an
    // http:// address is upgraded once the host is known (loopback exempt,
    // no public CA signs the local gateway).
    fun normalise(raw: String, policy: UrlPolicy = UrlPolicy()): NormalisedUrl {
        val input = raw.trim()
        if (input.isEmpty()) throw UrlException("URL is required")
        if (input.length > policy.maxUrlLength) {
            throw UrlException("URL is longer than ${policy.maxUrlLength} characters")
        }

        val maybeScheme = schemeOf(input)
        val scheme = maybeScheme ?: "https"

        if (scheme == "data") {
            if (!policy.allowDataHtml) throw UrlException("data: URLs are disabled")
            val lowered = lower(input)
            if (!lowered.startsWith("data:text/html,") && !lowered.startsWith("data:text/plain,")) {
                throw UrlException("only data:text/html and data:text/plain are allowed")
            }
            if (input.length > policy.maxDataUrlLength) {
                throw UrlException("data URL is longer than ${policy.maxDataUrlLength} characters")
            }
            return NormalisedUrl(input, "data", "", 0, "", false)
        }

        if (scheme == "about") {
            if (lower(input) != "about:blank") throw UrlException("only about:blank is allowed")
            return NormalisedUrl("about:blank", "about", "", 0, "", true)
        }

        if (scheme != "http" && scheme != "https") {
            throw UrlException("scheme '$scheme' is not allowed")
        }

        var url = input
        if (maybeScheme == null) {
            // No scheme was typed: a bare loopback authority is the local
            // gateway and only speaks http, while a bare public name gets
            // https-first.
            val cut = input.indexOfFirst { it == '/' || it == '?' || it == '#' }
            val authority = if (cut >= 0) input.substring(0, cut) else input
            val loopback = try {
                isLoopback(splitAuthority(authority).host)
            } catch (e: UrlException) {
                false
            }
            url = (if (loopback) "http://" else "https://") + url
        }
        if (hasIllegalCharacters(url)) throw UrlException("URL contains illegal characters")

        val schemeSeparator = url.indexOf("://")
        if (schemeSeparator < 0) throw UrlException("URL has no host")
        val afterScheme = url.substring(schemeSeparator + 3)

        fun authorityEnd(text: String): Int {
            var best = text.length
            for (needle in charArrayOf('/', '?', '#')) {
                val pos = text.indexOf(needle)
                if (pos in 0 until best) best = pos
            }
            return best
        }

        val end = authorityEnd(afterScheme)
        val authority = afterScheme.substring(0, end)
        val rest = afterScheme.substring(end)
        if (authority.isEmpty()) throw UrlException("URL has no host")

        // userinfo is a phishing trick in the authority bar: refuse it outright
        if (authority.contains('@')) {
            throw UrlException("URLs with embedded credentials are not allowed")
        }

        val (rawHost, port) = splitAuthority(authority)
        val loweredHost = lower(rawHost)
        if (loweredHost.isEmpty()) throw UrlException("URL has no host")
        if (loweredHost.contains(' ')) throw UrlException("invalid host")

        if (scheme == "http" && policy.httpsOnly && !isLoopback(loweredHost)) {
            url = "https://" + url.substring("http://".length)
        }

        return NormalisedUrl(
            url = url,
            scheme = lower(url.substring(0, url.indexOf("://"))),
            host = loweredHost,
            port = port,
            path = if (rest.isEmpty()) "/" else rest,
            secure = lower(url).startsWith("https://"),
        )
    }

    // Hostname validation: labels, length, and the private ranges that must
    // be refused unless the operator opted in.
    fun validateHostname(
        host: String,
        allowPrivate: Boolean = false,
        allowLocalhost: Boolean = false,
    ): String {
        val value = lower(host)
        if (value.isEmpty()) throw UrlException("host is required")
        if (value.length > 253) throw UrlException("host is longer than 253 characters")
        if (value[0] == '.' || value[value.length - 1] == '.') {
            throw UrlException("host has an empty label")
        }

        if (value[0] == '[') return value // IPv6 literals are opt-in targets

        if (isIpv4Literal(value)) {
            if (!allowPrivate && (isPrivateIpv4(value) || isLoopback(value))) {
                throw UrlException("private and loopback addresses are blocked by policy")
            }
            return value
        }

        for (label in value.split('.')) {
            if (label.isEmpty()) throw UrlException("host has an empty label")
            if (label.length > 63) throw UrlException("host label is longer than 63 characters")
            if (label[0] == '-' || label[label.length - 1] == '-') {
                throw UrlException("host label may not start or end with a hyphen")
            }
            for (c in label) {
                val ok = c.isLetterOrDigit() || c == '-' || c == '_'
                if (!ok) throw UrlException("host label contains an invalid character")
            }
        }

        if (isLoopback(value) && !allowLocalhost && !allowPrivate) {
            throw UrlException("localhost is blocked by policy")
        }
        if (!allowPrivate && value.endsWith(".local")) {
            throw UrlException("mDNS names are blocked by policy")
        }
        if (!allowPrivate && (value.endsWith(".internal") || value.endsWith(".lan"))) {
            throw UrlException("internal hostnames are blocked by policy")
        }
        return value
    }
}
