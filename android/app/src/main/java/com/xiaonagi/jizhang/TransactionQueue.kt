package com.xiaonagi.jizhang

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.security.MessageDigest
import java.util.UUID

/** Both listener and JS bridge use this process-wide lock; ack keeps recent dedupe keys. */
class TransactionQueue(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences("payment_queue", Context.MODE_PRIVATE)

    fun pending(): String = synchronized(lock) { read().getJSONArray("pending").toString() }

    fun enqueue(packageName: String, text: String, payment: PaymentParser.Payment, timestamp: Long): Boolean = synchronized(lock) {
        val state = read()
        val now = System.currentTimeMillis()
        val recent = JSONArray()
        val keyText = "$packageName|${payment.amount.toPlainString()}|${text.trim().replace(Regex("\\s+"), " ")}"
        val key = MessageDigest.getInstance("SHA-256").digest(keyText.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
        var duplicate = false
        val previous = state.getJSONArray("recent")
        for (i in 0 until previous.length()) {
            val item = previous.getJSONObject(i)
            if (now - item.getLong("seenAt") <= DEDUPE_MS) {
                recent.put(item)
                if (item.getString("key") == key) duplicate = true
            }
        }
        if (duplicate) return@synchronized false
        recent.put(JSONObject().put("key", key).put("seenAt", now))
        state.getJSONArray("pending").put(JSONObject()
            .put("id", UUID.randomUUID().toString())
            .put("source", payment.source).put("type", payment.type)
            .put("amount", payment.amount).put("counterparty", payment.merchant)
            .put("confidence", payment.confidence).put("text", text.take(16_384))
            .put("timestamp", timestamp))
        state.put("recent", recent)
        check(preferences.edit().putString("state", state.toString()).commit()) { "通知记录保存失败" }
        true
    }

    fun ack(idsJson: String) = synchronized(lock) {
        val ids = JSONArray(idsJson)
        val accepted = (0 until ids.length()).map { ids.getString(it) }.toSet()
        val state = read()
        val pending = state.getJSONArray("pending")
        val remaining = JSONArray()
        for (i in 0 until pending.length()) {
            val item = pending.getJSONObject(i)
            if (item.getString("id") !in accepted) remaining.put(item)
        }
        state.put("pending", remaining)
        check(preferences.edit().putString("state", state.toString()).commit()) { "通知确认保存失败" }
    }

    private fun read(): JSONObject = preferences.getString("state", null)?.let(::JSONObject)
        ?: JSONObject().put("pending", JSONArray()).put("recent", JSONArray())

    companion object {
        private val lock = Any()
        private const val DEDUPE_MS = 120_000L
    }
}
