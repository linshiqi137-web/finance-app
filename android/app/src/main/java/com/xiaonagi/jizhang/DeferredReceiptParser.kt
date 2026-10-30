package com.xiaonagi.jizhang

import java.text.Normalizer
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId
import java.util.UUID

/** Visible service-account cards only. Missing/ambiguous message times are not capture times. */
object DeferredReceiptParser {
    private val heading = Regex("^(?:微信支付凭证|付款凭证|支付凭证|收款凭证|收款到账通知|零钱提现(?:已到账|到账通知)?|退款到账通知|转账到账通知)$")
    private val dateTime = Regex("(20[0-9]{2})[-/年]([0-9]{1,2})[-/月]([0-9]{1,2})日?\\s+([0-9]{1,2}):([0-9]{2})(?::([0-9]{2}))?")
    private val clock = Regex("(?<![0-9])([0-9]{1,2}):([0-9]{2})(?::([0-9]{2}))?(?![0-9])")
    fun isServiceChat(texts: List<String>): Boolean = texts.take(8).any { it.trim() == "微信支付" } &&
        texts.none { it.trim() in setOf("通讯录", "发现") } &&
        texts.any { heading.matches(it.trim()) || Regex("付款金额|收款金额|零钱提现|退款成功|转账到账").containsMatchIn(it) }

    fun parse(texts: List<String>, now: Long, zone: ZoneId = ZoneId.systemDefault()): List<PaymentEvent> {
        if (texts.none { it.trim() == "微信支付" }) return emptyList()
        val lines = texts.flatMap { Normalizer.normalize(it, Normalizer.Form.NFKC).lines() }.map(String::trim).filter(String::isNotBlank)
        val starts = lines.indices.filter { heading.matches(lines[it]) }.map { index ->
            val preceding = lines.getOrNull(index - 1).orEmpty()
            if (index > 0 && !Regex("时间|日期").containsMatchIn(lines.getOrNull(index - 2).orEmpty()) && visibleTime(preceding, now, zone) != null &&
                !Regex("金额|元|[¥￥]|付款|收款|转账").containsMatchIn(preceding)) index - 1 else index
        }
        // A compact preview with explicit payment words can be supplied as one scoped list item.
        val blocks = if (starts.isEmpty()) listOf(lines) else starts.mapIndexed { index, start ->
            val end = starts.getOrNull(index + 1) ?: lines.size
            lines.subList(start, end)
        }
        val results = blocks.mapNotNull { block ->
            val text = block.joinToString("\n")
            val timestamp = visibleTime(text, now, zone) ?: return@mapNotNull null
            val event = NotificationExtrasParser.parseText("com.tencent.mm", "wechat", text, timestamp) ?: return@mapNotNull null
            val identity = "wechat|$timestamp|${event.amount}|${event.direction}|${event.merchant}"
            event.copy(eventId = UUID.nameUUIDFromBytes(identity.toByteArray(Charsets.UTF_8)).toString(), status = "candidate")
        }
        return results.groupBy { it.eventId }.values.map { group -> group.first().copy(ambiguous = group.size > 1) }
    }

    fun visibleTime(text: String, now: Long, zone: ZoneId): Long? {
        val full = dateTime.findAll(text).toList()
        try {
            if (full.isNotEmpty()) {
                val times = full.map { m -> LocalDateTime.of(m.groupValues[1].toInt(), m.groupValues[2].toInt(),
                    m.groupValues[3].toInt(), m.groupValues[4].toInt(), m.groupValues[5].toInt(), m.groupValues[6].ifEmpty { "0" }.toInt()).atZone(zone).toInstant().toEpochMilli() }.distinct()
                return times.singleOrNull()?.takeIf { it <= now + 60_000 }
            }
            // No implicit date for bare clocks: old messages and current messages can share HH:mm.
            val today = LocalDateTime.ofInstant(java.time.Instant.ofEpochMilli(now), zone).toLocalDate()
            val date: LocalDate = when { text.contains("昨天") -> today.minusDays(1); text.contains("今天") -> today; else -> return null }
            val clocks = clock.findAll(text).map { m -> LocalTime.of(m.groupValues[1].toInt(), m.groupValues[2].toInt(), m.groupValues[3].ifEmpty { "0" }.toInt()) }.distinct().toList()
            return clocks.singleOrNull()?.atDate(date)?.atZone(zone)?.toInstant()?.toEpochMilli()?.takeIf { it <= now + 60_000 }
        } catch (_: java.time.DateTimeException) { return null }
    }
}
