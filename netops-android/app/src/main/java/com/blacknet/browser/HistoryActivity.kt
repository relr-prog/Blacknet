package com.blacknet.browser

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.BaseAdapter
import android.widget.ListView
import android.widget.TextView
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import com.blacknet.browser.history.History
import com.blacknet.browser.history.HistoryEntry
import com.blacknet.browser.history.HistoryStore

// History is shell UI, not page content: it needs no bridge into the
// WebView and none exists. A tap hands the URL back to the browser,
// a long press deletes one entry, and Clear empties the table behind
// a confirmation.

class HistoryActivity : AppCompatActivity() {

    private lateinit var store: HistoryStore
    private lateinit var list: ListView
    private val rows = mutableListOf<HistoryEntry>()
    private lateinit var adapter: HistoryAdapter

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_history)

        store = HistoryStore.get(this)
        list = findViewById(R.id.history_list)
        list.emptyView = findViewById(R.id.history_empty)
        adapter = HistoryAdapter(this, rows)
        list.adapter = adapter

        list.setOnItemClickListener { _, _, position, _ ->
            val entry = rows[position]
            setResult(Activity.RESULT_OK, Intent().putExtra(EXTRA_URL, entry.url))
            finish()
        }
        list.setOnItemLongClickListener { _, _, position, _ ->
            confirmDelete(rows[position])
            true
        }

        findViewById<TextView>(R.id.history_clear).setOnClickListener { confirmClear() }
    }

    override fun onResume() {
        super.onResume()
        refresh()
    }

    private fun refresh() {
        rows.clear()
        rows.addAll(store.entries())
        adapter.notifyDataSetChanged()
    }

    private fun confirmDelete(entry: HistoryEntry) {
        AlertDialog.Builder(this)
            .setMessage(R.string.history_delete_confirm)
            .setPositiveButton(R.string.history_delete) { _, _ ->
                store.delete(entry.id)
                refresh()
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun confirmClear() {
        AlertDialog.Builder(this)
            .setMessage(R.string.history_clear_confirm)
            .setPositiveButton(R.string.action_clear) { _, _ ->
                store.clear()
                refresh()
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private class HistoryAdapter(
        private val activity: Activity,
        private val rows: List<HistoryEntry>,
    ) : BaseAdapter() {

        override fun getCount(): Int = rows.size
        override fun getItem(position: Int): Any = rows[position]
        override fun getItemId(position: Int): Long = rows[position].id

        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
            val view = convertView
                ?: LayoutInflater.from(activity).inflate(R.layout.history_row, parent, false)
            val entry = rows[position]
            view.findViewById<TextView>(R.id.history_title).text =
                entry.title.ifBlank { entry.url }
            view.findViewById<TextView>(R.id.history_meta).text = activity.getString(
                R.string.history_meta,
                History.relTime(System.currentTimeMillis(), entry.ts),
                entry.url,
            )
            return view
        }
    }

    companion object {
        const val EXTRA_URL = "com.blacknet.browser.HISTORY_URL"
    }
}
