package com.xiaonagi.jizhang

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.math.BigDecimal
import java.util.UUID

/** One process-wide lock, durable delivery before ack; unresolved events survive queue ack. */
class TransactionQueue(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences("payment_queue", Context.MODE_PRIVATE)
    fun pending(): String = synchronized(lock) { read().getJSONArray("pending").toString() }
    fun hasUnresolved(): Boolean = synchronized(lock) { events(read()).any { it.status == "unresolved" } }

    // v0.3 entry point and three-minute deduper are retained for both capture paths.
    fun enqueue(packageName: String, text: String, payment: PaymentParser.Payment, timestamp: Long): Boolean {
        require(packageName == packageFor(payment.source))
        val direction = EventDirection.classify(text, payment.type)
        return capture(PaymentEvent(source = payment.source, eventTime = timestamp, amount = payment.amount,
            merchant = payment.merchant, direction = direction.direction, accountingType = direction.type,
            confidence = payment.confidence, ownAccount = direction.ownAccount, directionKnown = direction.known), text)
    }

    fun capture(event: PaymentEvent, text: String = "", notificationIdentity: String? = null): Boolean = synchronized(lock) {
        require(event.source in setOf("wechat", "alipay"))
        val state = read()
        val seen = state.getJSONArray("notifications")
        if (notificationIdentity != null && (0 until seen.length()).any { seen.getString(it) == notificationIdentity }) return@synchronized false
        if (notificationIdentity != null) {
            seen.put(notificationIdentity)
            state.put("notifications", JSONArray((maxOf(0, seen.length() - 1000) until seen.length()).map { seen.getString(it) }))
        }
        if (events(state).any { it.eventId == event.eventId }) { persist(state); return@synchronized false }
        val decision = if (event.amount != null) dedupe(state, event) else DedupeResult(false, null)
        // Repeated accessibility window events must not grow the delivery queue every 600 ms.
        if (decision.duplicate && notificationIdentity == null) { persist(state); return@synchronized false }
        val accepted = if (decision.duplicate) event.copy(status = "duplicate", matchedEventId = decision.matchedEventId) else event
        // A detailed notification may itself resolve a prior opaque notification.
        if (accepted.status == "confirmed") {
            val match = DeferredEventMatcher.match(events(state), listOf(accepted.copy(status = "candidate"))).singleOrNull()
            if (match != null) {
                put(state, match.unresolved.copy(status = "reconciled", matchedEventId = accepted.eventId))
                put(state, accepted.copy(matchedEventId = match.unresolved.eventId), text)
            } else put(state, accepted, text)
        } else put(state, accepted, text)
        persist(state)
        accepted.status != "duplicate"
    }

    /** Receipts have real visible message times; matching never uses the time of opening WeChat. */
    fun recover(receipts: List<PaymentEvent>): Int = synchronized(lock) {
        val state = read()
        val existing = events(state)
        val candidates = receipts.distinctBy { it.eventId }.filter { candidate -> existing.none { it.eventId == candidate.eventId } }
        val matches = DeferredEventMatcher.match(existing, candidates)
        for (match in matches) {
            val decision = dedupe(state, match.receipt)
            val receipt = match.receipt.copy(status = if (decision.duplicate) "duplicate" else "confirmed",
                matchedEventId = if (decision.duplicate) decision.matchedEventId else match.unresolved.eventId)
            put(state, match.unresolved.copy(status = "reconciled", matchedEventId = decision.matchedEventId ?: receipt.eventId))
            put(state, receipt)
        }
        if (matches.isNotEmpty()) persist(state)
        matches.size
    }

    // Optional manual fill is saved by JS first. Retries are idempotent and close deferred recovery.
    fun resolve(eventId: String, amount: String) = synchronized(lock) {
        val value = amount.toBigDecimal().setScale(2)
        require(value > BigDecimal.ZERO && value <= BigDecimal("9999999999.99"))
        val state = read()
        val event = events(state).firstOrNull { it.eventId == eventId && it.status == "unresolved" } ?: return@synchronized
        val resolved = event.copy(amount = value, status = "confirmed")
        dedupe(state, resolved)
        put(state, resolved)
        persist(state)
    }

    fun ack(idsJson: String) = synchronized(lock) {
        val ids = JSONArray(idsJson)
        val accepted = (0 until ids.length()).map { ids.getString(it) }.toSet()
        val state = read()
        val pending = state.getJSONArray("pending")
        state.put("pending", JSONArray((0 until pending.length()).map { pending.getJSONObject(it) }.filter { it.getString("id") !in accepted }))
        persist(state)
    }

    private data class DedupeResult(val duplicate: Boolean, val matchedEventId: String?)

    private fun dedupe(state: JSONObject, event: PaymentEvent): DedupeResult {
        val previous = state.getJSONArray("recent")
        val entries = (0 until previous.length()).map { previous.getJSONObject(it).let { row -> PaymentDeduper.Entry(row.getString("key"), row.getLong("seenAt")) } }
        val key = PaymentDeduper.key(event.source, event.amount!!, event.accountingType)
        val now = System.currentTimeMillis()
        val decision = PaymentDeduper.check(entries, key, now)
        state.put("recent", JSONArray(decision.recent.map { JSONObject().put("key", it.key).put("seenAt", it.seenAt) }))
        if (!decision.duplicate) return DedupeResult(false, null)
        val matched = events(state).lastOrNull { it.status == "confirmed" && it.amount != null &&
            PaymentDeduper.key(it.source, it.amount, it.accountingType) == key && kotlin.math.abs(it.eventTime - event.eventTime) <= PaymentDeduper.WINDOW_MS }?.eventId
        return DedupeResult(true, matched)
    }

    private fun put(state: JSONObject, event: PaymentEvent, text: String = "") {
        val archive = events(state).filter { it.eventId != event.eventId } + event
        // Do not evict unresolved records. The delivery queue remains until a durable Web write.
        val retained = archive.filter { it.status == "unresolved" } + archive.filter { it.status != "unresolved" }.takeLast(1000)
        state.put("events", JSONArray(retained.map(::json)))
        state.getJSONArray("pending").put(json(event).put("id", UUID.randomUUID().toString()).put("text", text.take(16_384)))
    }
    private fun events(state: JSONObject): List<PaymentEvent> {
        val rows = state.getJSONArray("events")
        return (0 until rows.length()).map { fromJson(rows.getJSONObject(it)) }
    }
    private fun persist(state: JSONObject) { check(preferences.edit().putString("state", state.toString()).commit()) { "支付事件保存失败" } }
    private fun read(): JSONObject {
        val state = preferences.getString("state", null)?.let(::JSONObject)
            ?: JSONObject().put("pending", JSONArray()).put("recent", JSONArray())
        for (key in listOf("events", "notifications")) if (!state.has(key)) state.put(key, JSONArray())
        return state
    }
    companion object {
        private val lock = Any()
        fun packageFor(source: String) = if (source == "wechat") "com.tencent.mm" else "com.eg.android.AlipayGphone"
        fun json(e: PaymentEvent): JSONObject = JSONObject()
            .put("event_id", e.eventId).put("source", e.source).put("event_time", e.eventTime)
            .put("amount", e.amount ?: JSONObject.NULL).put("merchant", e.merchant).put("direction", e.direction)
            .put("confidence", e.confidence).put("status", e.status).put("matched_event_id", e.matchedEventId ?: JSONObject.NULL)
            .put("type", e.accountingType).put("counterparty", e.merchant).put("timestamp", e.eventTime)
            .put("own_account", e.ownAccount).put("direction_known", e.directionKnown).put("ambiguous", e.ambiguous)
        fun fromJson(o: JSONObject) = PaymentEvent(eventId = o.getString("event_id"), source = o.getString("source"),
            eventTime = o.getLong("event_time"), amount = if (o.isNull("amount")) null else o.getString("amount").toBigDecimal(),
            merchant = o.getString("merchant"), direction = o.getString("direction"), confidence = o.getString("confidence"),
            status = o.getString("status"), matchedEventId = if (o.isNull("matched_event_id")) null else o.getString("matched_event_id"),
            accountingType = o.getString("type"), ownAccount = o.optBoolean("own_account"),
            directionKnown = o.optBoolean("direction_known", true), ambiguous = o.optBoolean("ambiguous"))
    }
}
