package com.xiaonagi.jizhang

import org.junit.Assert.*
import org.junit.Test
import java.math.BigDecimal

class PaymentParserTest {
    private val wechat = "com.tencent.mm"
    private val alipay = "com.eg.android.AlipayGphone"

    // 示例数据 / example data: fictional payment notifications; no personal records.
    @Test fun wechatExpenses() {
        for (text in listOf("微信支付\n已支付￥12.50\n商户：示例食堂", "微信支付\n支付成功，付款¥12.50，商户：示例食堂", "微信支付\n支付成功 ￥12.50")) {
            val payment = PaymentParser.parse(wechat, text)!!
            assertEquals("wechat", payment.source)
            assertEquals("expense", payment.type)
            assertEquals(BigDecimal("12.50"), payment.amount)
            assertEquals("high", payment.confidence)
        }
        assertEquals("示例食堂", PaymentParser.parse(wechat, "微信支付\n已支付￥12.50\n商户：示例食堂")!!.merchant)
    }

    // 示例数据 / example data.
    @Test fun alipayExpensesAndMerchant() {
        val payment = PaymentParser.parse(alipay, "支付宝\n你已成功付款25.80元\n商家：示例咖啡馆")!!
        assertEquals("alipay", payment.source)
        assertEquals("expense", payment.type)
        assertEquals(BigDecimal("25.80"), payment.amount)
        assertEquals("示例咖啡馆", payment.merchant)
        assertEquals("high", payment.confidence)
        assertEquals("示例超市", PaymentParser.parse(alipay, "付款成功\n在示例超市消费 ¥18.00")!!.merchant)
        assertEquals("expense", PaymentParser.parse(alipay, "付款成功￥18.00\n收款方：示例超市")!!.type)
    }

    // 示例数据 / example data.
    @Test fun receiptsAndIncomingTransfers() {
        for (text in listOf("微信支付 收款到账30.00元", "收款￥30.00", "已收款30.00元", "示例甲向你转账30.00元", "收款到账\n金额：￥30.00")) {
            val payment = PaymentParser.parse(wechat, text)!!
            assertEquals(text, "income", payment.type)
            assertEquals(text, BigDecimal("30.00"), payment.amount)
        }
        assertEquals("示例甲", PaymentParser.parse(alipay, "示例甲向你转账30.00元")!!.merchant)
        assertEquals("income", PaymentParser.parse(alipay, "支付宝 收款到账￥30.00")!!.type)
    }

    // 示例数据 / example data: generic transfers are excluded from income/expense totals.
    @Test fun genericTransfers() {
        val payment = PaymentParser.parse(alipay, "转账成功\n转账金额：¥200.00")!!
        assertEquals("transfer", payment.type)
        assertEquals(BigDecimal("200.00"), payment.amount)
        assertEquals("low", payment.confidence)
        assertEquals("high", PaymentParser.parse(wechat, "转账￥200.00")!!.confidence)
    }

    // 示例数据 / example data: formatted, fullwidth and ambiguous notifications.
    @Test fun formattingAndConfidence() {
        assertEquals(BigDecimal("1234.56"), PaymentParser.parse(wechat, "微信支付 已支付 ￥1,234.56")!!.amount)
        assertEquals(BigDecimal("12.50"), PaymentParser.parse(wechat, "微信支付 已支付￥１２．５０")!!.amount)
        assertEquals(BigDecimal("12.00"), PaymentParser.parse(alipay, "你已成功付款12元")!!.amount)
        val payment = PaymentParser.parse(alipay, "付款成功\n示例商户\n金额：18.50元")!!
        assertEquals(BigDecimal("18.50"), payment.amount)
        assertEquals("low", payment.confidence)
        // Choose the payment amount, not another number such as the balance.
        assertEquals(BigDecimal("12.50"), PaymentParser.parse(wechat, "余额￥800.00\n已支付￥12.50")!!.amount)
        assertEquals("瑞幸", PaymentParser.parse(wechat, "微信支付 已支付￥12.50 瑞幸")!!.merchant)
    }

    // 示例数据 / example data: incomplete, unrelated and unsuccessful messages.
    @Test fun rejectsNonPayments() {
        for (text in listOf("微信支付", "支付成功", "你好，午饭12.50元", "余额￥12.50", "支付失败￥12.50", "待付款￥12.50", "已支付￥12.50，退款成功", "付款提醒￥12.50", "转账待确认￥12.50", "已支付￥0.00", "已支付￥-1.00", "已支付￥12.345", "已支付￥10000000000.00")) {
            assertNull(text, PaymentParser.parse(wechat, text))
        }
        assertNull(PaymentParser.parse("com.example.chat", "付款成功￥12.50"))
    }
}
