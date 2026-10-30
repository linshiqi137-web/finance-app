package com.xiaonagi.jizhang

import java.math.BigDecimal
import java.text.Normalizer

/** Android Bundle adapter supplies EVERY field, including each MessagingStyle message, separately. */
object NotificationExtrasParser {
    val fields = listOf("android.title", "android.text", "android.bigText", "android.textLines", "android.subText", "android.summaryText", "android.messages")
    private val paymentWords = Regex("微信支付|支付成功|付款|收款|转账|零钱提现|提现|退款|已支付|消费")
    private val failed = Regex("支付失败|付款失败|转账失败|交易失败|提现失败|退款失败|待支付|待付款|未付款|未支付|已取消|已关闭|待你收款|待您收款|确认收款|待收款|待领取")
    private const val NUMBER = "(?<![0-9.,+\\-])((?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\\.[0-9]{1,2})?)(?![0-9.]|,[0-9])"
    private val money = Regex("[¥￥]\\s*$NUMBER|$NUMBER\\s*元|(?:提现金额|退款金额|转账金额|支付金额|付款金额|收款金额|金额)\\s*[:：]?\\s*[¥￥]?\\s*$NUMBER")

    fun parse(packageName: String, extras: Map<String, List<String>>, timestamp: Long): List<PaymentEvent> {
        val source = when (packageName) { "com.tencent.mm" -> "wechat"; "com.eg.android.AlipayGphone" -> "alipay"; else -> return emptyList() }
        val title = extras["android.title"].orEmpty().joinToString("\n")
        val parts = extras.keys.filter { it != "android.title" }.flatMap { extras[it].orEmpty() }.filter(String::isNotBlank).distinct()
        val all = (listOf(title) + parts).joinToString("\n")
        if (!paymentWords.containsMatchIn(all)) return emptyList()
        val parsed = parts.mapNotNull { part -> parseText(packageName, source, "$title\n$part", timestamp) }
            .filter { it.amount != null }
        // Repeated TEXT/BIG_TEXT/MESSAGES representations describe the same transaction.
        if (parsed.isNotEmpty()) return parsed.distinctBy { listOf(it.amount, it.direction, it.merchant) }
        // Fields can split status, merchant and amount. Balance text is not a payment amount.
        val amountText = all.lines().filterNot { Regex("余额|可用额度").containsMatchIn(it) }.joinToString("\n")
        val conflicting = money.findAll(amountText).mapNotNull { match ->
            match.groupValues.drop(1).firstOrNull(String::isNotBlank)?.replace(",", "")?.toBigDecimalOrNull()
        }.distinct().count() > 1
        if (!conflicting) parseText(packageName, source, all, timestamp)?.takeIf { it.amount != null }?.let { return listOf(it) }
        if (source != "wechat" || failed.containsMatchIn(all) || !Regex("支付成功|付款|收款|转账|零钱提现|提现|退款|已支付|消费|微信支付.*条.*消息", RegexOption.DOT_MATCHES_ALL).containsMatchIn(all)) return emptyList()
        val direction = EventDirection.classify(all)
        return listOf(PaymentEvent(source = source, eventTime = timestamp, amount = null,
            merchant = merchant(all), direction = direction.direction, accountingType = direction.type, ownAccount = direction.ownAccount,
            directionKnown = direction.known, ambiguous = conflicting || Regex("\\[(?:[2-9]|[1-9][0-9]+)条]|收到了?(?:[2-9]|[1-9][0-9]+)条").containsMatchIn(all)))
    }

    private fun merchant(text: String): String = Regex("(?:商户(?:名称)?|商家|交易对方|收款方|付款方)\\s*[:：]\\s*([^\\n;；,，]+)")
        .find(text)?.groupValues?.get(1)?.trim()?.take(80).orEmpty()

    fun parseText(packageName: String, source: String, raw: String, timestamp: Long): PaymentEvent? {
        val text = Normalizer.normalize(raw, Normalizer.Form.NFKC)
        if (failed.containsMatchIn(text)) return null
        val old = AccessibilityPaymentParser.parse(packageName, text.lines()) ?: PaymentParser.parse(packageName, text)
        val direction = EventDirection.classify(text, old?.type)
        val special = direction.direction in setOf("withdraw", "refund") || direction.ownAccount
        if (old == null && (!special || !Regex("到账|到帐|成功|已退|已转|已完成").containsMatchIn(text))) return null
        val amounts = money.findAll(text).mapNotNull { match ->
            match.groupValues.drop(1).firstOrNull(String::isNotBlank)?.replace(",", "")?.toBigDecimalOrNull()
        }.distinct().toList()
        val amount = old?.amount ?: amounts.singleOrNull() ?: return null
        if (amount <= BigDecimal.ZERO || amount > BigDecimal("9999999999.99")) return null
        // Generic transfer notifications stay excluded, matching v0.3 semantics.
        return PaymentEvent(source = source, eventTime = timestamp, amount = amount.setScale(2), merchant = old?.merchant ?: merchant(text),
            direction = direction.direction, accountingType = direction.type, ownAccount = direction.ownAccount,
            directionKnown = direction.known, confidence = old?.confidence ?: "high")
    }
}
