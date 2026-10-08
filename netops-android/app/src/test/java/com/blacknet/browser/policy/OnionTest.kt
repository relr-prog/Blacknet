package com.blacknet.browser.policy

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OnionTest {

    @Test
    fun hostOutOfAFullAddress() {
        assertEquals(
            "abcdefgh12345678.onion",
            Onion.onionHost("http://abcdefgh12345678.onion/path?q=1"),
        )
    }

    @Test
    fun portIsNotTheHost() {
        assertEquals("abcdefgh12345678.onion", Onion.onionHost("abcdefgh12345678.onion:8080"))
    }

    @Test
    fun credentialsAreNotTheHost() {
        assertEquals("xyz.onion", Onion.onionHost("http://user:pass@xyz.onion/"))
        assertEquals("x.onion", Onion.onionHost("user@x.onion"))
    }

    @Test
    fun caseAndSchemeFold() {
        assertEquals("xyz.onion", Onion.onionHost("HTTP://XYZ.ONION"))
        assertEquals("abc.onion", Onion.onionHost("AbC.OnIon."))
    }

    @Test
    fun notOnion() {
        assertNull(Onion.onionHost("example.com"))
        assertNull(Onion.onionHost("x.onion.evil.com"))
        assertNull(Onion.onionHost("onion"))
        assertNull(Onion.onionHost("abc.onionx"))
        assertNull(Onion.onionHost(""))
        assertNull(Onion.onionHost(null))
        assertNull(Onion.onionHost("   "))
        assertFalse(Onion.isOnion("example.com"))
        assertTrue(Onion.isOnion("http://abcdefgh12345678.onion/"))
    }
}
