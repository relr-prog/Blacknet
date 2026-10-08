package com.blacknet.browser

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.ImageButton
import android.widget.PopupMenu
import android.widget.ProgressBar
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader
import com.blacknet.browser.policy.BrowserPolicy
import com.blacknet.browser.policy.Pages

class MainActivity : AppCompatActivity(), TabManager.Listener {

    private lateinit var policy: BrowserPolicy
    private lateinit var manager: TabManager
    private lateinit var omnibox: EditText
    private lateinit var blockedBadge: TextView
    private lateinit var progress: ProgressBar
    private lateinit var backButton: ImageButton
    private lateinit var forwardButton: ImageButton

    private val historyLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val url = result.data?.getStringExtra(HistoryActivity.EXTRA_URL)
            if (!url.isNullOrEmpty()) navigate(url, showAddress = url)
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        omnibox = findViewById(R.id.omnibox)
        blockedBadge = findViewById(R.id.blocked_badge)
        progress = findViewById(R.id.progress)
        backButton = findViewById(R.id.back_button)
        forwardButton = findViewById(R.id.forward_button)
        val reloadButton: ImageButton = findViewById(R.id.reload_button)
        val tabsButton: ImageButton = findViewById(R.id.tabs_button)
        val moreButton: ImageButton = findViewById(R.id.more_button)

        policy = BrowserPolicy()
        val assetLoader = WebViewAssetLoader.Builder()
            .setDomain(Pages.HOST)
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
        manager = TabManager(findViewById(R.id.web_container), this, policy, assetLoader, this)

        omnibox.setOnEditorActionListener { _, actionId, _ ->
            if (actionId == EditorInfo.IME_ACTION_GO) {
                navigateFromOmnibox()
                true
            } else {
                false
            }
        }
        omnibox.setOnFocusChangeListener { _, hasFocus ->
            if (hasFocus) omnibox.selectAll()
        }

        backButton.setOnClickListener { manager.current?.webView?.let { if (it.canGoBack()) it.goBack() } }
        forwardButton.setOnClickListener { manager.current?.webView?.let { if (it.canGoForward()) it.goForward() } }
        reloadButton.setOnClickListener { reload() }
        tabsButton.setOnClickListener { showTabsDialog() }
        moreButton.setOnClickListener { showMoreMenu(it) }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val tab = manager.current
                if (tab != null && tab.webView.canGoBack()) {
                    tab.webView.goBack()
                } else {
                    finish()
                }
            }
        })

        manager.newTab()
        omnibox.requestFocus()
        omnibox.post {
            getSystemService(InputMethodManager::class.java)
                .showSoftInput(omnibox, InputMethodManager.SHOW_IMPLICIT)
        }
    }

    private fun navigateFromOmnibox() {
        val raw = omnibox.text.toString().trim()
        if (raw.isEmpty()) return
        val target = policy.targetFor(raw)
        navigate(target, showAddress = target)
    }

    // The one entry point for shell-initiated loads: the verdict decides
    // between a real navigation and the refusal page, and the address bar
    // keeps what was typed either way.
    private fun navigate(target: String, showAddress: String) {
        val tab = manager.current ?: return
        when (val verdict = policy.verdict(target)) {
            is BrowserPolicy.Verdict.Allowed -> {
                tab.refusedTarget = null
                tab.webView.loadUrl(verdict.normalised.url)
                if (!omnibox.isFocused) omnibox.setText(verdict.normalised.url)
                else omnibox.setText(showAddress)
            }
            is BrowserPolicy.Verdict.Refused -> {
                tab.refusedTarget = target
                val replace = manager.isOnRefusalPage(tab)
                if (replace) {
                    val script =
                        "window.location.replace(" + org.json.JSONObject.quote(Pages.refusal(target)) + ")"
                    tab.webView.evaluateJavascript(script, null)
                } else {
                    tab.webView.loadUrl(Pages.refusal(target))
                }
                omnibox.setText(showAddress)
            }
        }
        omnibox.clearFocus()
        hideKeyboard()
        manager.dispatchPageUpdated(tab)
    }

    private fun reload() {
        val tab = manager.current ?: return
        val refused = tab.refusedTarget
        if (refused != null && manager.isOnRefusalPage(tab)) {
            navigate(refused, showAddress = refused)
        } else {
            tab.webView.reload()
        }
    }

    private fun showTabsDialog() {
        val names = manager.tabs.map { manager.displayTitle(it) }.toTypedArray()
        val checked = manager.tabs.indexOf(manager.current)
        AlertDialog.Builder(this)
            .setTitle(R.string.action_tabs)
            .setSingleChoiceItems(names, checked) { dialog, which ->
                manager.switchTo(manager.tabs[which])
                dialog.dismiss()
            }
            .setPositiveButton(R.string.action_new_tab) { _, _ -> manager.newTab() }
            .setNeutralButton(R.string.action_close_tab) { _, _ ->
                manager.current?.let { manager.close(it) }
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun showMoreMenu(anchor: View) {
        val popup = PopupMenu(this, anchor)
        popup.menu.add(0, MENU_HISTORY, 0, getString(R.string.action_history))
        popup.setOnMenuItemClickListener { item ->
            when (item.itemId) {
                MENU_HISTORY -> {
                    historyLauncher.launch(Intent(this, HistoryActivity::class.java))
                    true
                }
                else -> false
            }
        }
        popup.show()
    }

    private fun hideKeyboard() {
        getSystemService(InputMethodManager::class.java)
            .hideSoftInputFromWindow(omnibox.windowToken, 0)
    }

    override fun onTabsChanged(manager: TabManager) {
        updateBlockedBadge()
        updateArrows()
    }

    override fun onPageUpdated(manager: TabManager, tab: Tab) {
        if (tab !== manager.current) return
        if (!omnibox.isFocused) {
            omnibox.setText(manager.displayAddress(tab))
        }
        updateArrows()
    }

    override fun onPageStarted(manager: TabManager, tab: Tab) {
        if (tab !== manager.current) return
        if (!omnibox.isFocused) {
            omnibox.setText(manager.displayAddress(tab))
        }
        progress.visibility = View.VISIBLE
        progress.progress = 0
    }

    override fun onBlockedUpdated(manager: TabManager, tab: Tab) {
        if (tab !== manager.current) return
        updateBlockedBadge()
    }

    override fun onProgress(manager: TabManager, tab: Tab, percent: Int) {
        if (tab !== manager.current) return
        progress.progress = percent
        progress.visibility = if (percent >= 100) View.GONE else View.VISIBLE
    }

    private fun updateArrows() {
        val tab = manager.current?.webView
        backButton.isEnabled = tab?.canGoBack() == true
        forwardButton.isEnabled = tab?.canGoForward() == true
    }

    private fun updateBlockedBadge() {
        val blocked = manager.current?.blocked ?: 0
        if (blocked > 0) {
            blockedBadge.visibility = View.VISIBLE
            blockedBadge.text = blocked.toString()
            blockedBadge.contentDescription =
                getString(R.string.blocked_count) + " " + blocked
        } else {
            blockedBadge.visibility = View.GONE
        }
    }

    companion object {
        private const val MENU_HISTORY = 1
    }
}
