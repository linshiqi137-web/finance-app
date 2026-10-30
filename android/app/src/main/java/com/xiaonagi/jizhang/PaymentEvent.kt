package com.xiaonagi.jizhang

import java.math.BigDecimal
import java.text.Normalizer
import java.util.UUID

/** Unified, local event. Null amount is intentional; it must never enter totals. */
data class PaymentEvent(
    val eventId: String = UUID.randomUUID().toString(),
    val source: String,
    val eventTime: Long,
    val amount: BigDecimal?,
    val merchant: String = "",
    val direction: String,
    val confidence: String = "low",
    val status: String = if (amount == null) "unresolved" else "confirmed",
    val matchedEventId: String? = null,
    val accountingType: String = "transfer",
    val ownAccount: Boolean = false,
    val directionKnown: Boolean = true,
    val ambiguous: Boolean = false,
)

object EventDirection {
    data class Result(val direction: String, val type: String, val ownAccount: Boolean = false, val known: Boolean = true)
    fun classify(raw: String, fallback: String? = null): Result {
        val text = Normalizer.normalize(raw, Normalizer.Form.NFKC)
        if (Regex("零钱提现|提现|余额转出到银行卡").containsMatchIn(text)) return Result("withdraw", "transfer", true)
        val own = Regex("本人账户|本人银行卡|自己账户|自己的账户|同名账户|自有账户|余额宝转入|余额宝转出|零钱通转入|零钱通转出|充值到零钱|零钱充值").containsMatchIn(text)
        if (own) {
            val incoming = Regex("转入|充值").containsMatchIn(text)
            return Result(if (incoming) "transfer_in" else "transfer_out", "transfer", true)
        }
        if (text.contains("退款")) return Result("refund", "refund")
        if (text.contains("转账")) {
            if (Regex("收到.*转账|向[你您]转账|你已收款|您已收款|已存入零钱").containsMatchIn(text) || fallback == "income")
                return Result("transfer_in", "income")
            if (Regex("转账成功|待对方收款|对方已收款|你已转账|你向|转账给").containsMatchIn(text) || fallback == "expense")
                return Result("transfer_out", "expense")
            return Result("transfer_out", "transfer", known = false)
        }
        if (fallback == "income" || Regex("收款到账|收款到帐|收款金额|收款凭证|你已收款|您已收款").containsMatchIn(text)) return Result("income", "income")
        if (fallback == "expense" || Regex("支付成功|付款成功|已支付|付款金额|付款凭证|消费|已发出|已发送").containsMatchIn(text)) return Result("expense", "expense")
        return Result("expense", "expense", known = false)
    }
}

/** Time is a gate, never a nearest-neighbour guess. Match must be unique in BOTH directions. */
object DeferredEventMatcher {
    const val WINDOW_MS = 10 * 60_000L
    data class Match(val unresolved: PaymentEvent, val receipt: PaymentEvent)
    fun match(unresolved: List<PaymentEvent>, receipts: List<PaymentEvent>): List<Match> {
        val choices = unresolved.filter { it.status == "unresolved" && !it.ambiguous }.associateWith { pending ->
            receipts.filter { receipt ->
                receipt.source == pending.source && receipt.amount != null && receipt.status == "candidate" &&
                    !receipt.ambiguous && receipt.directionKnown && (!pending.ownAccount || receipt.ownAccount) && kotlin.math.abs(receipt.eventTime - pending.eventTime) <= WINDOW_MS
            }.filter { !pending.directionKnown || it.direction == pending.direction }
                .filter { pending.merchant.isBlank() || it.merchant.trim() == pending.merchant.trim() }
        }
        return choices.mapNotNull { (pending, candidates) ->
            val receipt = candidates.singleOrNull() ?: return@mapNotNull null
            if (choices.values.count { receipt in it } != 1) null else Match(pending, receipt)
        }
    }
}
