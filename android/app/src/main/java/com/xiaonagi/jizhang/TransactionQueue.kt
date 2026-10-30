package com.xiaonagi.jizhang

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** Both capture services and JS bridge use this process-wide lock; ack keeps dedupe keys. */
class TransactionQueue(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences("payment_queue", Context.MODE_PRIVATE)

    fun pending(): String = synchronized(lock) { read().getJSONArray("pending").toString() }

    fun enqueue(packageName: String, text: String, payment: PaymentParser.Payment, timestamp: Long): Boolean = synchronized(lock) {
        val state = read()
        val now = System.currentTimeMillis()
        require(packageName == when (payment.source) {
            "wechat" -> "com.tencent.mm"
            "alipay" -> "com.eg.android.AlipayGphone"
            else -> error("未知支付来源")
        })
        val previous = state.getJSONArray("recent")
        val entries = (0 until previous.length()).map { i ->
            val item = previous.getJSONObject(i)
            PaymentDeduper.Entry(item.getString("key"), item.getLong("seenAt"))
        }
        val decision = PaymentDeduper.check(entries, PaymentDeduper.key(payment.source, payment.amount, payment.type), now)
        if (decision.duplicate) return@synchronized false
        val recent = JSONArray()
        for (item in decision.recent) recent.put(JSONObject().put("key", item.key).put("seenAt", item.seenAt))
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
    }
}
