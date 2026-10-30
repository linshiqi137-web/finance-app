package com.xiaonagi.jizhang

import java.math.BigDecimal
import java.text.Normalizer

/** Pure Kotlin parser for ordered, visible accessibility-node text. Never guesses hidden amounts. */
object AccessibilityPaymentParser {
    private const val NUMBER = "(?<![0-9.,+\\-])((?:[0-9]{1,3}(?:,[0-9]{3})+|[0-9]+)(?:\\.[0-9]{1,2})?)(?![0-9.]|,[0-9])"
    private val currency = Regex("[¥￥]\\s*$NUMBER|$NUMBER\\s*元")
    private val labelled = Regex("(?:付款金额|收款金额|转账金额|红包金额|总金额|实付金额|实付款|支付金额|金额)\\s*[:：]?\\s*[¥￥]?\\s*$NUMBER(?:\\s*元)?")
    private val bareAmount = Regex("^[¥￥]?\\s*$NUMBER\\s*(?:元)?$")
    private val serviceAmount = Regex("付款金额|收款金额")
    private val receiptHeading = Regex("^(?:微信支付凭证|(?:微信支付)?(?:付款凭证|支付凭证|收款凭证|收款到账通知))$")
    private val rejected = Regex("支付失败|付款失败|转账失败|交易失败|未支付|未付款|待支付|待付款|等待付款|退款|已取消|已关闭|已退还|已过期")
    private val merchantLabel = Regex("^(?:商户(?:名称|全称)?|商家(?:名称)?|收款商户|交易对方|收款方|收款人|付款方|付款人|对方)(?:\\s*[:：]\\s*|\\s+|$)(.*)$")

    fun parse(packageName: String, texts: List<String>): PaymentParser.Payment? = parseAll(packageName, texts).firstOrNull()

    /** A service-account list may contain several independent receipts in one window. */
    fun parseAll(packageName: String, texts: List<String>): List<PaymentParser.Payment> {
        val source = when (packageName) {
            "com.tencent.mm" -> "wechat"
            "com.eg.android.AlipayGphone" -> "alipay"
            else -> return emptyList()
        }
        val lines = texts.take(512).flatMap {
            Normalizer.normalize(it.take(4096), Normalizer.Form.NFKC).lines()
        }.map(String::trim).filter(String::isNotEmpty).take(1024)
        if (lines.isEmpty()) return emptyList()
        if (source == "wechat") {
            val labels = lines.indices.filter { serviceAmount.containsMatchIn(lines[it]) }
            if (labels.isNotEmpty()) {
                return labels.mapIndexedNotNull { index, start ->
                    val previous = if (index == 0) 0 else labels[index - 1] + 1
                    val heading = (previous..start).lastOrNull { receiptHeading.matches(lines[it]) }
                    val end = labels.getOrNull(index + 1)?.let { next ->
                        (start + 1..next).firstOrNull { receiptHeading.matches(lines[it]) } ?: next
                    } ?: lines.size
                    val block = lines.subList(heading ?: if (index == 0) 0 else start, end)
                    val type = if (lines[start].contains("收款金额")) "income" else "expense"
                    payment(source, type, block, labelledOnly = true)
                }
            }
        }
        val text = lines.joinToString("\n")
        val type = when {
            source == "wechat" && text.contains("红包") -> {
                if (Regex("收到的红包|领取红包|红包待领取|塞钱进红包").containsMatchIn(text) ||
                    !Regex("已发出|已发送|你发出的红包|发出红包|已发红包|发送成功|发红包成功").containsMatchIn(text)) return emptyList()
                "expense"
            }
            text.contains("转账") -> when {
                Regex("待你收款|待您收款|确认收款|待收款|转账待确认").containsMatchIn(text) -> return emptyList()
                Regex("你已收款|您已收款|已收钱|已存入零钱").containsMatchIn(text) -> "income"
                Regex("待对方收款|对方已收款|转账成功|你已转账|你向|转账给").containsMatchIn(text) -> "expense"
                text.contains("已收款") -> "income"
                else -> return emptyList()
            }
            source == "wechat" && Regex("你已收款|您已收款").containsMatchIn(text) -> "income"
            Regex("支付成功|付款成功").containsMatchIn(text) -> "expense"
            else -> return emptyList()
        }
        return listOfNotNull(payment(source, type, lines))
    }

    private fun payment(source: String, type: String, lines: List<String>, labelledOnly: Boolean = false): PaymentParser.Payment? {
        val text = lines.joinToString("\n")
        if (rejected.containsMatchIn(text)) return null
        val match = labelled.find(text) ?: if (labelledOnly) return null else currency.find(text)
            ?: lines.firstNotNullOfOrNull { bareAmount.matchEntire(it) } ?: return null
        val amount = match.groupValues.drop(1).firstOrNull(String::isNotEmpty)
            ?.replace(",", "")?.toBigDecimalOrNull() ?: return null
        if (amount <= BigDecimal.ZERO || amount > BigDecimal("9999999999.99")) return null
        return PaymentParser.Payment(source, type, amount.setScale(2), merchant(lines, type), "high", text)
    }

    private fun merchant(lines: List<String>, type: String): String {
        for ((index, line) in lines.withIndex()) {
            val match = merchantLabel.matchEntire(line) ?: continue
            // Prefer the sender on incoming transfers, and the recipient on outgoing ones.
            if (type == "income" && Regex("^(?:收款方|收款人)").containsMatchIn(line)) continue
            val name = match.groupValues[1].ifBlank { lines.getOrNull(index + 1).orEmpty() }
            if (name.isNotBlank() && !labelled.containsMatchIn(name) && !currency.containsMatchIn(name)) return name.take(80)
        }
        Regex("(?:你向|转账给)\\s*([^\\n¥￥]+?)(?:转账|\\n|$)").find(lines.joinToString("\n"))?.let {
            return it.groupValues[1].trim().take(80)
        }
        // WeChat success pages commonly put the merchant immediately before/after the amount.
        val amountIndex = lines.indexOfFirst { bareAmount.matches(it) }
        if (amountIndex >= 0) {
            for (index in listOf(amountIndex - 1, amountIndex + 1)) {
                val name = lines.getOrNull(index) ?: continue
                if (!Regex("支付|付款|收款|转账|红包|金额|零钱|余额|完成|返回|详情|时间|单号|方式|服务|微信|支付宝").containsMatchIn(name)
                    && !bareAmount.matches(name) && name.any(Char::isLetter)) return name.take(80)
            }
        }
        return ""
    }
}
