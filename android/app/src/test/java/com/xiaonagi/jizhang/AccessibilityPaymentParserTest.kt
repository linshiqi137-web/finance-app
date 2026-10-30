package com.xiaonagi.jizhang

import org.junit.Assert.*
import org.junit.Test
import java.math.BigDecimal

class AccessibilityPaymentParserTest {
    private val wechat = "com.tencent.mm"
    private val alipay = "com.eg.android.AlipayGphone"

    // 示例数据 / example data: fictional ordered UI node texts, not real account data.
    private fun check(texts: List<String>, amount: String, direction: String, merchant: String = "", pkg: String = wechat) {
        val payment = AccessibilityPaymentParser.parse(pkg, texts)!!
        assertEquals(BigDecimal(amount), payment.amount)
        assertEquals(direction, payment.type)
        assertEquals(merchant, payment.merchant)
        assertEquals(if (pkg == wechat) "wechat" else "alipay", payment.source)
    }

    @Test fun wechatSuccessAndSplitCurrencyNodes() {
        check(listOf("支付成功", "示例食堂", "¥12.50", "完成"), "12.50", "expense", "示例食堂")
        check(listOf("支付成功", "￥", "１２．５０", "收款方", "示例书店"), "12.50", "expense", "示例书店")
        check(listOf("支付成功", "余额 ¥800.00", "实付金额", "￥1,234.56", "商户名称：示例超市"),
            "1234.56", "expense", "示例超市")
        check(listOf("支付成功", "12.50", "示例咖啡馆"), "12.50", "expense", "示例咖啡馆")
    }

    // 示例数据 / example data: outgoing and incoming transfer detail screens.
    @Test fun wechatTransferDirections() {
        check(listOf("转账", "¥88.00", "待对方收款", "收款人", "示例乙"), "88.00", "expense", "示例乙")
        check(listOf("转账", "¥88.00", "对方已收款", "收款人：示例乙"), "88.00", "expense", "示例乙")
        check(listOf("微信转账", "¥88.00", "你已收款", "付款方", "示例甲"), "88.00", "income", "示例甲")
        check(listOf("示例甲", "¥88.00", "你已收款", "已存入零钱"), "88.00", "income", "示例甲")
        check(listOf("转账", "￥88.00", "已收款", "付款人：示例甲"), "88.00", "income", "示例甲")
        check(listOf("转账", "你向示例乙转账", "¥88.00", "已收款"), "88.00", "expense", "示例乙")
    }

    // 示例数据 / example data: multiple independent WeChat Pay service-account entries.
    @Test fun serviceAccountReceiptsKeepAmountsAndMerchantsTogether() {
        val texts = listOf("微信支付", "付款凭证", "付款金额", "￥12.50", "收款方", "示例食堂",
            "收款凭证", "付款方", "示例甲", "收款金额", "30.00元", "收款时间", "2026年10月31日",
            "付款凭证", "付款金额：¥9.90", "商户名称：示例书店")
        val payments = AccessibilityPaymentParser.parseAll(wechat, texts)
        assertEquals(listOf("12.50", "30.00", "9.90"), payments.map { it.amount.toPlainString() })
        assertEquals(listOf("expense", "income", "expense"), payments.map { it.type })
        assertEquals(listOf("示例食堂", "示例甲", "示例书店"), payments.map { it.merchant })
        val withoutHeadings = AccessibilityPaymentParser.parseAll(wechat,
            listOf("微信支付", "付款金额", "¥12.50", "商户：示例食堂", "收款金额", "¥30.00", "付款方：示例甲"))
        assertEquals(listOf("示例食堂", "示例甲"), withoutHeadings.map { it.merchant })
    }

    // 示例数据 / example data: a failed card must not hide another successful card.
    @Test fun serviceAccountFailureIsScopedToItsOwnReceipt() {
        val payments = AccessibilityPaymentParser.parseAll(wechat, listOf("微信支付", "付款凭证", "付款金额", "¥5.00",
            "退款成功", "付款凭证", "付款金额", "¥6.00", "商户：示例食堂"))
        assertEquals(1, payments.size)
        assertEquals(BigDecimal("6.00"), payments.single().amount)
        val adjacent = AccessibilityPaymentParser.parseAll(wechat, listOf("微信支付", "微信支付凭证", "付款金额", "¥5.00",
            "商户：示例食堂", "微信支付凭证", "支付失败", "付款金额", "¥6.00"))
        assertEquals(BigDecimal("5.00"), adjacent.single().amount)
    }

    // 示例数据 / example data: red packet send confirmation, never an unsubmitted form.
    @Test fun sentRedPackets() {
        check(listOf("微信红包", "你发出的红包", "红包金额", "¥20.00"), "20.00", "expense")
        check(listOf("微信红包", "已发出", "总金额", "¥20.00"), "20.00", "expense")
    }

    // 示例数据 / example data: Alipay outgoing payments and transfers.
    @Test fun alipaySuccessPages() {
        for (status in listOf("支付成功", "付款成功", "转账成功")) {
            check(listOf(status, "¥25.80", "收款方", "示例咖啡馆"), "25.80", "expense", "示例咖啡馆", alipay)
        }
        check(listOf("转账成功", "转账金额", "100.00", "收款人：示例乙"), "100.00", "expense", "示例乙", alipay)
    }

    // 示例数据 / example data: no amounts may be inferred from opaque notifications or pending pages.
    @Test fun rejectsIncompleteUnsuccessfulAndUnrelatedTexts() {
        for (texts in listOf(
            listOf("微信支付收到了3条消息"), listOf("收到一笔转账"), listOf("支付成功"),
            listOf("转账", "¥50.00", "待你收款"), listOf("转账", "¥50.00", "确认收款"),
            listOf("转账", "¥50.00"), listOf("支付失败", "¥12.50"),
            listOf("支付成功", "¥12.50", "退款成功"), listOf("支付成功", "¥0.00"),
            listOf("支付成功", "¥-1.00"), listOf("支付成功", "¥12.345"),
            listOf("支付成功", "¥-1.00元"), listOf("支付成功", "12.345元"),
            listOf("支付成功", "1,23元"),
            listOf("支付成功", "¥10000000000.00"), listOf("你好，午饭12.50元"),
            listOf("微信红包", "¥20.00", "塞钱进红包"), listOf("微信红包", "¥20.00", "收到的红包")
        )) assertNull(texts.toString(), AccessibilityPaymentParser.parse(wechat, texts))
        assertNull(AccessibilityPaymentParser.parse("com.example.chat", listOf("支付成功", "¥12.50")))
    }
}
