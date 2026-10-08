package com.blacknet.browser.policy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class UrlTest {

    private fun refusal(raw: String): String {
        try {
            Url.normalise(raw)
        } catch (e: UrlException) {
            return e.message ?: ""
        }
        fail("expected refusal for $raw")
        return ""
    }

    @Test
    fun bareHostGetsHttpsFirst() {
        val out = Url.normalise("example.com")
        assertEquals("https://example.com", out.url)
        assertEquals("https", out.scheme)
        assertEquals("example.com", out.host)
        assertEquals("/", out.path)
    }

    @Test
    fun httpUpgradesToHttps() {
        val out = Url.normalise("http://example.com/a")
        assertEquals("https://example.com/a", out.url)
        assertEquals("https", out.scheme)
    }

    @Test
    fun loopbackKeepsItsHttp() {
        val out = Url.normalise("localhost:8787")
        assertEquals("http://localhost:8787", out.url)
        assertEquals("localhost", out.host)

        val gateway = Url.normalise("http://127.0.0.1:9050/x")
        assertEquals("http://127.0.0.1:9050/x", gateway.url)
    }

    @Test
    fun hostPortWithoutSchemeIsNotAScheme() {
        val out = Url.normalise("example.com:8080")
        assertEquals("https://example.com:8080", out.url)
        assertEquals(8080, out.port)
    }

    @Test
    fun dangerousSchemesAreRefused() {
        assertTrue(refusal("javascript:alert(1)").contains("scheme 'javascript' is not allowed"))
        assertTrue(refusal("file:///etc/passwd").contains("scheme 'file' is not allowed"))
        assertTrue(refusal("intent://x#Intent;end").contains("scheme 'intent' is not allowed"))
    }

    @Test
    fun dataUrlsOnlyHtmlAndPlain() {
        assertEquals("data:text/html,<b>x</b>", Url.normalise("data:text/html,<b>x</b>").url)
        assertTrue(refusal("data:text/css,body{}").contains("only data:text/html"))
    }

    @Test
    fun aboutOnlyBlank() {
        assertEquals("about:blank", Url.normalise("about:blank").url)
        assertTrue(refusal("about:config").contains("only about:blank"))
    }

    @Test
    fun embeddedCredentialsAreRefused() {
        assertTrue(
            refusal("https://user:pass@example.com")
                .contains("embedded credentials are not allowed"),
        )
    }

    @Test
    fun illegalCharactersAreRefused() {
        assertTrue(refusal("https://exa mple.com").contains("illegal characters"))
        assertTrue(refusal("https://a<b.com").contains("illegal characters"))
    }

    @Test
    fun lengthCap() {
        val long = "https://example.com/" + "a".repeat(3000)
        assertTrue(refusal(long).contains("longer than 2048"))
    }

    @Test
    fun emptyIsRefused() {
        assertTrue(refusal("   ").contains("URL is required"))
    }

    @Test
    fun privateRanges() {
        assertTrue(Url.isPrivateIpv4("10.0.0.1"))
        assertTrue(Url.isPrivateIpv4("127.0.0.1"))
        assertTrue(Url.isPrivateIpv4("192.168.1.1"))
        assertTrue(Url.isPrivateIpv4("172.16.0.1"))
        assertTrue(Url.isPrivateIpv4("172.31.255.255"))
        assertTrue(Url.isPrivateIpv4("169.254.1.1"))
        assertTrue(Url.isPrivateIpv4("100.64.0.1"))
        assertTrue(Url.isPrivateIpv4("0.0.0.0"))
        assertTrue(!Url.isPrivateIpv4("172.32.0.1"))
        assertTrue(!Url.isPrivateIpv4("100.128.0.1"))
        assertTrue(!Url.isPrivateIpv4("8.8.8.8"))
        assertTrue(!Url.isPrivateIpv4("not-an-ip"))
    }

    @Test
    fun loopbackHelpers() {
        assertTrue(Url.isLoopback("localhost"))
        assertTrue(Url.isLoopback("LOCALHOST"))
        assertTrue(Url.isLoopback("127.0.0.1"))
        assertTrue(Url.isLoopback("::1"))
        assertTrue(Url.isLoopback("127.1.2.3"))
        assertTrue(!Url.isLoopback("example.com"))
    }

    @Test
    fun hostnamePolicyDefaults() {
        assertEquals("example.com", Url.validateHostname("EXAMPLE.COM"))
        assertEquals("[::1]", Url.validateHostname("[::1]"))

        expectHostRefusal("localhost", "localhost is blocked by policy")
        expectHostRefusal("192.168.0.1", "private and loopback")
        expectHostRefusal("127.0.0.1", "private and loopback")
        expectHostRefusal(".example.com", "empty label")
        expectHostRefusal("example..com", "empty label")
        expectHostRefusal("foo.local", "mDNS")
        expectHostRefusal("printer.lan", "internal")
        expectHostRefusal("host.internal", "internal")
        expectHostRefusal("-bad.com", "hyphen")
        expectHostRefusal("bad-.com", "hyphen")
        expectHostRefusal("a".repeat(64) + ".com", "longer than 63")
        expectHostRefusal("exa mple.com", "invalid character")

        assertEquals("localhost", Url.validateHostname("localhost", allowLocalhost = true))
        assertEquals("192.168.0.1", Url.validateHostname("192.168.0.1", allowPrivate = true))
    }

    private fun expectHostRefusal(host: String, fragment: String) {
        try {
            Url.validateHostname(host)
            fail("expected refusal for $host")
        } catch (e: UrlException) {
            assertTrue(
                "message '${e.message}' should contain '$fragment'",
                (e.message ?: "").contains(fragment),
            )
        }
    }
}
