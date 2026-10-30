package com.xiaonagi.jizhang

import java.math.BigDecimal
import java.text.Normalizer

/** Pure Kotlin: no notification, Context or other Android dependencies. */
object PaymentParser {
    data class Payment(
        val source: String,
        val type: String,
        val amount: BigDecimal,
        val merchant: String,
        val confidence: String,
        val context: String = "", // Ephemeral parser block, never stored by accessibility capture.
    )

    private const val NUMBER = "((?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\\.[0-9]{1,2})?)(?![0-9.]|,[0-9])"
    private const val MONEY = "[¥￥]?\\s*$NUMBER\\s*(?:元)?"
    private val outgoing = Regex("(?:你已成功付款|已支付|付款|支付成功|付款成功|成功支付|消费)\\s*[:：]?\\s*$MONEY")
    private val incoming = Regex("(?:收款到账|收款到帐|收款|已收款|到账|到帐|向你转账|向您转账)\\s*[:：]?\\s*$MONEY")
    private val transferAmount = Regex("转账\\s*[:：]?\\s*$MONEY")
    private val currencyAmount = Regex("[¥￥]\\s*$NUMBER|$NUMBER\\s*元")
    private val incomeWords = Regex("收款到账|收款到帐|已收款|收款(?!方|人|码)|向[你您]转账")
    private val expenseWords = Regex("已支付|你已成功付款|支付成功|付款成功|付款[¥￥\\s:]|成功支付|消费")
    private val rejected = Regex("支付失败|付款失败|交易失败|未支付|未付款|待支付|待付款|等待付款|付款提醒|支付提醒|退款|已关闭|已取消|转账待确认|待收款|待领取")
    private val knownMerchants = listOf("美团", "饿了么", "肯德基", "麦当劳", "瑞幸", "星巴克", "食堂", "滴滴", "地铁", "公交", "12306", "淘宝", "京东", "拼多多")

    fun parse(packageName: String, text: String): Payment? {
        val source = when (packageName) {
            "com.tencent.mm" -> "wechat"
            "com.eg.android.AlipayGphone" -> "alipay"
            else -> return null
        }
        val normalized = Normalizer.normalize(text.take(16_384), Normalizer.Form.NFKC)
        if (rejected.containsMatchIn(normalized)) return null
        val type = when {
            incomeWords.containsMatchIn(normalized) -> "income"
            normalized.contains("转账") -> "transfer"
            expenseWords.containsMatchIn(normalized) -> "expense"
            else -> return null
        }
        val direct = when (type) {
            "income" -> incoming.find(normalized)
            "transfer" -> transferAmount.find(normalized)
            else -> outgoing.find(normalized)
        }
        val match = direct ?: currencyAmount.find(normalized) ?: return null
        val amount = match.groupValues.drop(1).firstOrNull { it.isNotEmpty() }
            ?.replace(",", "")?.toBigDecimalOrNull() ?: return null
        if (amount <= BigDecimal.ZERO || amount > BigDecimal("9999999999.99")) return null
        return Payment(source, type, amount.setScale(2), merchant(normalized), if (direct != null) "high" else "low", normalized)
    }

    private fun merchant(text: String): String {
        val patterns = listOf(
            Regex("(?:商户(?:名称)?|商家|交易对方|收款方|付款方)\\s*[:：]\\s*([^\\n;；,，]+)"),
            Regex("(?:付款给|支付给)\\s*([^\\n;；,，¥￥]+)"),
            Regex("(?:在|向)\\s*([^\\n;；,，¥￥]{1,40}?)(?:消费|付款|支付)"),
            Regex("(?:^|\\n)([^\\n:：]{1,40}?)向[你您]转账"),
        )
        for (pattern in patterns) {
            val name = pattern.find(text)?.groupValues?.get(1)?.trim()?.trim('。', ' ') ?: continue
            if (name.isNotEmpty()) return name.take(80)
        }
        return knownMerchants.firstOrNull { text.contains(it) }.orEmpty()
    }
}
