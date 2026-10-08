package com.blacknet.browser.policy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class BlocklistTest {

    @Test
    fun builtinCountMatchesTheDesktopShell() {
        assertEquals(56, Blocklist().size)
        assertEquals(56, Blocklist.BUILTIN_PATTERNS.size)
    }

    @Test
    fun hostRuleCoversExactAndSubdomains() {
        val list = Blocklist()
        assertTrue(list.checkHost("doubleclick.net").blocked)
        assertTrue(list.checkHost("www.doubleclick.net").blocked)
        assertTrue(list.checkHost("a.b.doubleclick.net").blocked)
        assertFalse(list.checkHost("notdoubleclick.net").blocked)
        assertFalse(list.checkHost("doubleclick.net.evil.com").blocked)
        assertFalse(list.checkHost("example.com").blocked)
    }

    @Test
    fun verdictCarriesPatternAndSource() {
        val verdict = Blocklist().checkHost("www.google-analytics.com")
        assertTrue(verdict.blocked)
        assertEquals("google-analytics.com", verdict.pattern)
        assertEquals("builtin", verdict.source)
    }

    @Test
    fun pathRulesMatchTheWholeUrl() {
        val list = Blocklist()
        assertTrue(list.check("https://www.googlesyndication.com/pagead/x").blocked)
        assertTrue(list.check("https://www.googletagmanager.com/gtm.js").blocked)
        assertTrue(list.check("https://facebook.com/tr/visit").blocked)
        assertFalse(list.check("https://example.com/about").blocked)
    }

    @Test
    fun configuredRulesAreExtra() {
        val list = Blocklist(listOf("ads.example.org"))
        assertTrue(list.checkHost("www.ads.example.org").blocked)
        assertEquals("config", list.checkHost("www.ads.example.org").source)
        assertEquals(57, list.size)
    }

    @Test
    fun hostSuffixNeedsTheDot() {
        val list = Blocklist()
        list.addRule(".suffix.example", "test")
        assertTrue(list.checkHost("a.suffix.example").blocked)
        assertFalse(list.checkHost("suffix.example").blocked)
    }

    @Test
    fun cidrRulesScanTheUrl() {
        val list = Blocklist()
        list.addRule("10.0.0.0/8", "test")
        assertTrue(list.check("https://beacon.example/?ip=10.1.2.3").blocked)
        assertFalse(list.check("https://beacon.example/?ip=11.1.2.3").blocked)
        assertTrue(list.check("https://beacon.example/?next=10.0.0.1").blocked)
    }

    @Test
    fun regexRules() {
        val list = Blocklist()
        list.addRule("re:tracker-[0-9]+", "test")
        assertTrue(list.check("https://example.com/tracker-42").blocked)
        assertFalse(list.check("https://example.com/clean").blocked)
    }

    @Test
    fun aBrokenRegexNeverMatchesButStaysLoaded() {
        val list = Blocklist()
        list.addRule("re:(", "test")
        assertFalse(list.check("https://example.com/anything").blocked)
    }

    @Test
    fun kindsFollowTheDesktopGrammar() {
        val list = Blocklist()
        list.addRule("re:x", "test")
        list.addRule("10.0.0.0/8", "test")
        list.addRule(".suffix", "test")
        list.addRule("host.example/path", "test")
        list.addRule("plain.example", "test")
        val kinds = list.rules().takeLast(5).map { it.kind }
        assertEquals(
            listOf(
                RuleKind.Regex,
                RuleKind.Cidr,
                RuleKind.HostSuffix,
                RuleKind.Path,
                RuleKind.Host,
            ),
            kinds,
        )
    }
}
