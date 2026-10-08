package com.blacknet.browser.history

import com.blacknet.browser.policy.BrowserPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HistoryTest {

    private val policy = BrowserPolicy()

    @Test
    fun recordsPagesThatActuallyLoaded() {
        assertTrue(History.shouldRecord(policy, "https://example.com/"))
        assertTrue(History.shouldRecord(policy, "http://example.com/path?q=1"))
        assertTrue(History.shouldRecord(policy, "https://docs.python.org/3/library/"))
    }

    @Test
    fun skipsRefusedTargets() {
        assertFalse(History.shouldRecord(policy, "http://expyuzz4wqqyqhjn.onion/"))
        assertFalse(History.shouldRecord(policy, "http://10.0.0.5/admin"))
        assertFalse(History.shouldRecord(policy, "http://192.168.1.1/"))
        assertFalse(History.shouldRecord(policy, "http://printer.local/"))
        assertFalse(History.shouldRecord(policy, "http://build.internal/status"))
    }

    @Test
    fun skipsTrackerUrls() {
        assertFalse(History.shouldRecord(policy, "https://ad.doubleclick.net/x"))
        assertFalse(History.shouldRecord(policy, "https://connect.facebook.net/en_US/fbevents.js"))
    }

    @Test
    fun skipsShellPagesAndNonWebUrls() {
        assertFalse(
            History.shouldRecord(
                policy,
                "https://appassets.androidplatform.net/assets/newtab.html",
            ),
        )
        assertFalse(
            History.shouldRecord(
                policy,
                "https://appassets.androidplatform.net/assets/unreachable.html?target=abc",
            ),
        )
        assertFalse(History.shouldRecord(policy, "about:blank"))
        assertFalse(History.shouldRecord(policy, "data:text/html,<b>hi</b>"))
        assertFalse(History.shouldRecord(policy, ""))
        assertFalse(History.shouldRecord(policy, null))
    }

    @Test
    fun relTimeMomentsAndMinutes() {
        val now = 1_700_000_000_000L
        assertEquals("just now", History.relTime(now, now))
        assertEquals("just now", History.relTime(now, now - 59_000))
        assertEquals("1m ago", History.relTime(now, now - 60_000))
        assertEquals("59m ago", History.relTime(now, now - 3_599_000))
    }

    @Test
    fun relTimeHoursAndDays() {
        val now = 1_700_000_000_000L
        assertEquals("1h ago", History.relTime(now, now - 3_600_000))
        assertEquals("23h ago", History.relTime(now, now - 86_400_000 + 1_000))
        assertEquals("1d ago", History.relTime(now, now - 86_400_000))
        assertEquals("6d ago", History.relTime(now, now - 6 * 86_400_000))
    }

    @Test
    fun relTimeOlderEntriesReadAsADate() {
        val now = 1_700_000_000_000L
        val out = History.relTime(now, now - 30L * 86_400_000)
        assertTrue("expected a date, got: $out", out.matches(Regex("""[A-Z][a-z]{2} \d{1,2}, \d{4}""")))
    }

    @Test
    fun relTimeNeverGoesNegative() {
        val now = 1_700_000_000_000L
        assertEquals("just now", History.relTime(now, now + 60_000))
    }
}
