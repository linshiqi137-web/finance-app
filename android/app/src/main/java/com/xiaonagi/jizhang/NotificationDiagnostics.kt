package com.xiaonagi.jizhang

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

/** Raw payment notification text, private app storage only. Never Logcat, network or backups. */
class NotificationDiagnostics(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("notification_diagnostics", Context.MODE_PRIVATE)
    fun append(record: JSONObject) = synchronized(lock) {
        val rows = JSONArray(prefs.getString("log", "[]"))
        rows.put(record)
        val last = JSONArray((maxOf(0, rows.length() - 50) until rows.length()).map { rows.getJSONObject(it) })
        check(prefs.edit().putString("log", last.toString()).commit())
    }
    fun read(): String = synchronized(lock) { JSONArray(prefs.getString("log", "[]")).toString(2) }
    fun clear() = synchronized(lock) { check(prefs.edit().remove("log").commit()) }
    companion object { private val lock = Any() }
}
