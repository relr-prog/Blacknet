package com.blacknet.browser.policy

// The refusal decision for hidden-service addresses, ported from the desktop
// shell's onion.js. Runs before anything asks the network, so the browser
// shows its own explanation instead of handing the address to a resolver.

object Onion {

    private val ONION_HOST = Regex("^[a-z0-9-]+\\.onion$")

    // The host, without the parts of the address that are not the host:
    // scheme, credentials, port, path, trailing dot, letter case. Read back
    // from the address rather than passed as a second value that could
    // disagree with it.
    fun onionHost(value: String?): String? {
        var text = value?.trim() ?: return null
        if (text.isEmpty()) return null
        text = text.replace(Regex("^[a-z][a-z0-9+.-]*://", RegexOption.IGNORE_CASE), "")
        text = text.replace(Regex("^//"), "")
        text = text.split(Regex("[/?#]"))[0]
        val at = text.lastIndexOf('@')
        if (at >= 0) text = text.substring(at + 1)
        if (text.startsWith("[")) {
            val close = text.indexOf(']')
            text = if (close > 0) text.substring(1, close) else ""
        } else {
            text = text.replace(Regex(":\\d+$"), "")
        }
        text = text.replace(Regex("\\.$"), "").lowercase()
        return if (ONION_HOST.matches(text)) text else null
    }

    fun isOnion(value: String?): Boolean = onionHost(value) != null
}
