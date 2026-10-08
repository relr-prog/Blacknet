package com.blacknet.browser.history

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

// One row per URL: visiting again moves the entry back to the top and
// refreshes its title instead of growing a trail of duplicates. The table
// is capped, because a browser history that grows without bound is a
// question the user never agreed to answer.

data class HistoryEntry(val id: Long, val url: String, val title: String, val ts: Long)

class HistoryStore(context: Context) :
    SQLiteOpenHelper(context.applicationContext, DB_NAME, null, DB_VERSION) {

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            "CREATE TABLE history (" +
                "id INTEGER PRIMARY KEY AUTOINCREMENT, " +
                "url TEXT NOT NULL UNIQUE, " +
                "title TEXT NOT NULL DEFAULT '', " +
                "ts INTEGER NOT NULL)",
        )
        db.execSQL("CREATE INDEX idx_history_ts ON history(ts DESC)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        db.execSQL("DROP TABLE IF EXISTS history")
        onCreate(db)
    }

    fun recordVisit(url: String, title: String, ts: Long) {
        if (url.isEmpty()) return
        val db = writableDatabase
        db.beginTransaction()
        try {
            val cursor = db.query(
                TABLE, arrayOf("id", "title"), "url = ?", arrayOf(url),
                null, null, null,
            )
            val exists = cursor.moveToFirst()
            val id = if (exists) cursor.getLong(0) else -1L
            val storedTitle = if (exists) cursor.getString(1) ?: "" else ""
            cursor.close()
            if (exists) {
                val update = ContentValues().apply {
                    put("ts", ts)
                    if (title.isNotBlank() && title != storedTitle) put("title", title)
                }
                db.update(TABLE, update, "id = ?", arrayOf(id.toString()))
            } else {
                val insert = ContentValues().apply {
                    put("url", url)
                    put("title", title)
                    put("ts", ts)
                }
                db.insert(TABLE, null, insert)
            }
            db.execSQL(
                "DELETE FROM history WHERE id NOT IN " +
                    "(SELECT id FROM history ORDER BY ts DESC LIMIT $MAX_ENTRIES)",
            )
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    fun entries(limit: Int = 100): List<HistoryEntry> {
        val out = mutableListOf<HistoryEntry>()
        val cursor = readableDatabase.query(
            TABLE, arrayOf("id", "url", "title", "ts"),
            null, null, null, null, "ts DESC", limit.toString(),
        )
        while (cursor.moveToNext()) {
            out.add(
                HistoryEntry(
                    cursor.getLong(0),
                    cursor.getString(1),
                    cursor.getString(2),
                    cursor.getLong(3),
                ),
            )
        }
        cursor.close()
        return out
    }

    fun delete(id: Long) {
        writableDatabase.delete(TABLE, "id = ?", arrayOf(id.toString()))
    }

    fun clear() {
        writableDatabase.delete(TABLE, null, null)
    }

    companion object {
        private const val DB_NAME = "blacknet-history.db"
        private const val DB_VERSION = 1
        private const val TABLE = "history"
        const val MAX_ENTRIES = 2000

        @Volatile
        private var instance: HistoryStore? = null

        fun get(context: Context): HistoryStore =
            instance ?: synchronized(this) {
                instance ?: HistoryStore(context).also { instance = it }
            }
    }
}
