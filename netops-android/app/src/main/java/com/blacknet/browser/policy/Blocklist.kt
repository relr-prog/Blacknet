package com.blacknet.browser.policy

// Request blocking: a compiled matcher for trackers, ad hosts and extra
// rules, ported from the desktop shell's native blocklist.cpp. Rule kinds,
// matching order and the false-positive guards (never substring-match a
// host rule) are the same, so both builds block the same requests.

enum class RuleKind { Host, HostSuffix, Path, Regex, Cidr }

data class BlockRule(val kind: RuleKind, val pattern: String, val source: String)

data class BlockVerdict(val blocked: Boolean, val pattern: String = "", val source: String = "")

class Blocklist(extra: List<String> = emptyList()) {

    private val rules = mutableListOf<BlockRule>()
    private val hostRules = mutableListOf<BlockRule>()
    private val hostIndex = mutableSetOf<String>()
    private val regexes = mutableMapOf<Int, Regex>()

    init {
        for (pattern in BUILTIN_PATTERNS) addRule(pattern, "builtin")
        for (pattern in extra) addRule(pattern, "config")
    }

    val size: Int get() = rules.size

    fun rules(): List<BlockRule> = rules.toList()

    private fun looksLikeCidr(pattern: String): Boolean {
        val slash = pattern.indexOf('/')
        if (slash < 0) return false
        if (!parseIpv4(pattern.substring(0, slash), null)) return false
        val length = pattern.substring(slash + 1)
        if (length.isEmpty() || length.length > 2) return false
        for (c in length) if (!c.isDigit()) return false
        val bits = length.toInt()
        return bits in 0..32
    }

    private fun parseIpv4(text: String, out: IntArray?): Boolean {
        if (out != null && out.size < 4) return false
        var index = 0
        for (part in 0 until 4) {
            if (part > 0) {
                if (index >= text.length || text[index] != '.') return false
                index++
            }
            var value = 0
            var digits = 0
            while (index < text.length && text[index].isDigit()) {
                value = value * 10 + (text[index] - '0')
                if (value > 255) return false
                index++
                digits++
            }
            if (digits == 0) return false
            if (out != null) out[part] = value
        }
        return index == text.length
    }

    private fun cidrContains(pattern: String, address: String): Boolean {
        val slash = pattern.indexOf('/')
        if (slash < 0) return false
        val network = IntArray(4)
        val candidate = IntArray(4)
        if (!parseIpv4(pattern.substring(0, slash), network)) return false
        if (!parseIpv4(address, candidate)) return false
        val bits = pattern.substring(slash + 1).toInt()
        val mask = if (bits == 0) 0 else (0xffffffff.toInt() shl (32 - bits))
        val networkValue = (network[0] shl 24) or (network[1] shl 16) or (network[2] shl 8) or network[3]
        val candidateValue =
            (candidate[0] shl 24) or (candidate[1] shl 16) or (candidate[2] shl 8) or candidate[3]
        return (networkValue and mask) == (candidateValue and mask)
    }

    fun addRule(patternRaw: String, source: String) {
        val value = patternRaw.trim().lowercase()
        if (value.isEmpty()) return

        val rule = when {
            value.startsWith("re:") ->
                BlockRule(RuleKind.Regex, value.substring(3), source)
            looksLikeCidr(value) ->
                BlockRule(RuleKind.Cidr, value, source)
            value[0] == '.' ->
                BlockRule(RuleKind.HostSuffix, value.substring(1), source)
            value.contains('/') ->
                BlockRule(RuleKind.Path, value, source)
            else ->
                BlockRule(RuleKind.Host, value, source)
        }

        if (rule.kind == RuleKind.Host || rule.kind == RuleKind.HostSuffix) {
            if (hostIndex.add(rule.pattern)) hostRules.add(rule)
        }
        rules.add(rule)
        compileRegexes()
    }

    private fun compileRegexes() {
        regexes.clear()
        for ((i, rule) in rules.withIndex()) {
            if (rule.kind != RuleKind.Regex) continue
            try {
                regexes[i] = Regex(rule.pattern, RegexOption.IGNORE_CASE)
            } catch (e: Exception) {
                // An operator typo must not take the whole browser down: keep
                // the rule visible in the dump, but never match on it.
            }
        }
    }

    fun checkHost(rawHost: String): BlockVerdict {
        val value = rawHost.lowercase()
        if (value.isEmpty()) return BlockVerdict(false)

        for (rule in hostRules) {
            if (rule.kind == RuleKind.Host) {
                // exact host or any subdomain, but never "notdoubleclick.net"
                if (value == rule.pattern || value.endsWith("." + rule.pattern)) {
                    return BlockVerdict(true, rule.pattern, rule.source)
                }
            } else if (rule.kind == RuleKind.HostSuffix) {
                if (value.endsWith("." + rule.pattern)) {
                    return BlockVerdict(true, rule.pattern, rule.source)
                }
            }
        }

        for ((i, rule) in rules.withIndex()) {
            if (rule.kind != RuleKind.Regex) continue
            val regex = regexes[i] ?: continue
            if (regex.containsMatchIn(value)) {
                return BlockVerdict(true, rule.pattern, rule.source)
            }
        }
        return BlockVerdict(false)
    }

    fun check(rawUrl: String): BlockVerdict {
        val value = rawUrl.lowercase()
        if (value.isEmpty()) return BlockVerdict(false)

        try {
            val parsed = Url.normalise(value, UrlPolicy(allowDataHtml = true))
            val hostVerdict = checkHost(parsed.host)
            if (hostVerdict.blocked) return hostVerdict
        } catch (e: UrlException) {
            // Unparseable as a URL: no host to check, the rest still applies.
        }

        for (rule in rules) {
            // Path rules are matched against the whole URL so that they cover
            // both "host/path" built-ins and bare path fragments. Host rules
            // are handled by checkHost() above: substring matching them here
            // produced false positives such as "notdoubleclick.net".
            if (rule.kind == RuleKind.Path && value.contains(rule.pattern)) {
                return BlockVerdict(true, rule.pattern, rule.source)
            }
            if (rule.kind == RuleKind.Cidr) {
                // Block beacons that carry an address anywhere in the URL
                // (query strings, referrers and beacon paths all end up here).
                var cursor = 0
                while (cursor < value.length) {
                    var start = cursor
                    while (start < value.length && !value[start].isDigit()) start++
                    if (start >= value.length) break
                    var end = start
                    while (end < value.length && (value[end].isDigit() || value[end] == '.')) end++
                    if (cidrContains(rule.pattern, value.substring(start, end))) {
                        return BlockVerdict(true, rule.pattern, rule.source)
                    }
                    cursor = end
                }
            }
            if (rule.kind == RuleKind.Regex) {
                val index = rules.indexOf(rule)
                val regex = regexes[index] ?: continue
                if (regex.containsMatchIn(value)) {
                    return BlockVerdict(true, rule.pattern, rule.source)
                }
            }
        }
        return BlockVerdict(false)
    }

    companion object {
        val BUILTIN_PATTERNS = listOf(
            "doubleclick.net",
            "googlesyndication.com/pagead",
            "google-analytics.com",
            "googleadservices.com",
            "googletagmanager.com/gtm.js",
            "analytics.tiktok.com",
            "connect.facebook.net",
            "facebook.com/tr",
            "bat.bing.com",
            "analytics.yahoo.com",
            "scorecardresearch.com",
            "quantserve.com",
            "hotjar.com",
            "fullstory.com",
            "mixpanel.com",
            "segment.io",
            "segment.com/api",
            "amplitude.com",
            "branch.io",
            "crazyegg.com",
            "optimizely.com",
            "sentry.io/api",
            "newrelic.com",
            "nr-data.net",
            "clarity.ms",
            "yandex.ru/metrika",
            "mc.yandex.ru",
            "adservice.google",
            "ads-twitter.com",
            "adnxs.com",
            "rubiconproject.com",
            "pubmatic.com",
            "openx.net",
            "criteo.com",
            "taboola.com",
            "outbrain.com",
            "snapchat.com/tr",
            "tiktok.com/api",
            "hotjar.io",
            "fingerprintjs.com",
            "bugsnag.com",
            "intercom.io",
            "driftt.com",
            "zendesk.com/embed",
            "onetrust.com",
            "cookiebot.com",
            "cookielaw.org",
            "usercentrics.eu",
            "cloudflareinsights.com",
            "speedcurve.com",
            "loggly.com",
            "datadoghq.com",
            "statuspage.io",
            "mapbox.com",
            "googleapis.com/recaptcha",
            "hcaptcha.com",
        )
    }
}
