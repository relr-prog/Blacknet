package com.blacknet.browser.policy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class BrowserPolicyTest {

    private val policy = BrowserPolicy()

    private fun refused(raw: String): BrowserPolicy.Verdict.Refused {
        val verdict = policy.verdict(raw)
        assertTrue("expected refusal for $raw, got $verdict", verdict is BrowserPolicy.Verdict.Refused)
        return verdict as BrowserPolicy.Verdict.Refused
    }

    private fun allowed(raw: String): BrowserPolicy.Verdict.Allowed {
        val verdict = policy.verdict(raw)
        assertTrue("expected allowance for $raw, got $verdict", verdict is BrowserPolicy.Verdict.Allowed)
        return verdict as BrowserPolicy.Verdict.Allowed
    }

    @Test
    fun onionRefusalComesFirst() {
        val verdict = refused("http://abcdefgh12345678.onion/index.html")
        assertEquals(BrowserPolicy.Kind.Onion, verdict.kind)
        assertEquals("abcdefgh12345678.onion", Onion.onionHost("http://abcdefgh12345678.onion/index.html"))
    }

    @Test
    fun trackerDomainsAreRefused() {
        assertEquals(BrowserPolicy.Kind.Tracker, refused("doubleclick.net").kind)
        assertEquals(BrowserPolicy.Kind.Tracker, refused("https://www.google-analytics.com/collect").kind)
    }

    @Test
    fun privateHostsAreRefused() {
        assertEquals(BrowserPolicy.Kind.HostPolicy, refused("192.168.1.1").kind)
        assertEquals(BrowserPolicy.Kind.HostPolicy, refused("10.1.2.3:8080").kind)
        assertEquals(BrowserPolicy.Kind.HostPolicy, refused("foo.local").kind)
        assertEquals(BrowserPolicy.Kind.HostPolicy, refused("router.lan").kind)
    }

    @Test
    fun loopbackIsExemptFromTheHostPolicy() {
        allowed("localhost")
        allowed("127.0.0.1")
        allowed("localhost:8787")
        allowed("http://127.0.0.1:9050/x")
    }

    @Test
    fun gatewayAddressesLoad() {
        allowed("example.com")
        allowed("https://example.org/path")
        // The host policy speaks before an engine-internal page would load:
        // nothing with an empty host gets past a verdict, same as the shell.
        assertEquals(BrowserPolicy.Kind.HostPolicy, refused("about:blank").kind)
    }

    @Test
    fun parseRefusalsCarryTheUrlPolicyReason() {
        val verdict = refused("javascript:alert(1)")
        assertTrue(verdict.reason.contains("url policy"))
        assertEquals(BrowserPolicy.Kind.Parse, verdict.kind)
        assertTrue(refused("").reason.contains("URL is required"))
        assertTrue(refused("https://user@evil.com").reason.contains("embedded credentials"))
    }

    @Test
    fun omniboxInputRouting() {
        assertEquals("example.com", policy.targetFor("example.com"))
        assertEquals("localhost:3000", policy.targetFor("localhost:3000"))
        assertEquals(
            "https://duckduckgo.com/?q=hello+world",
            policy.targetFor("hello world"),
        )
        assertTrue(policy.targetFor("javascript:alert(1)").startsWith("javascript:"))
    }

    @Test
    fun pagesRoundTripTheRefusedAddress() {
        val target = "http://abcdefgh12345678.onion/?q=x y"
        val page = Pages.refusal(target)
        assertTrue(Pages.isAsset(page))
        assertTrue(Pages.isRefusal(page))
        assertEquals(target, Pages.refusalTargetOf(page))
        assertTrue(Pages.isAsset(Pages.NEW_TAB))
        assertTrue(!Pages.isRefusal(Pages.NEW_TAB))
    }
}
