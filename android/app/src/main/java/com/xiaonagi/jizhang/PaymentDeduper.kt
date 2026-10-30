package com.xiaonagi.jizhang

import java.math.BigDecimal

/** Shared by both capture paths via TransactionQueue; snapshots survive ack and process restart. */
object PaymentDeduper {
    const val WINDOW_MS = 180_000L
    data class Entry(val key: String, val seenAt: Long)
    data class Decision(val duplicate: Boolean, val recent: List<Entry>)

    fun key(source: String, amount: BigDecimal, direction: String): String =
        "$source|${amount.setScale(2).toPlainString()}|$direction"

    fun check(recent: List<Entry>, key: String, now: Long): Decision {
        val active = recent.filter { now - it.seenAt in 0..WINDOW_MS }
        val duplicate = active.any { it.key == key }
        // Repeated window events must not extend the original suppression period indefinitely.
        return Decision(duplicate, if (duplicate) active else active + Entry(key, now))
    }
}
