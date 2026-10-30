package com.xiaonagi.jizhang

import org.junit.Assert.*
import org.junit.Test
import java.math.BigDecimal
import java.time.ZoneId
import java.time.ZonedDateTime

/** 示例数据 / example data: fabricated notification extras and service-account messages. */
class PaymentEventTest {
    private val wechat = "com.tencent.mm"
    private val alipay = "com.eg.android.AlipayGphone"
    private val zone = ZoneId.of("Asia/Shanghai")
    private val now = ZonedDateTime.of(2026, 10, 31, 12, 31, 0, 0, zone).toInstant().toEpochMilli()
    private fun extras(field: String, value: String) = mapOf("android.title" to listOf("微信支付"), field to listOf(value))
    private fun pending(id: String = "示例待补全", direction: String = "expense", merchant: String = "", time: Long = now) =
        PaymentEvent(eventId = id, source = "wechat", eventTime = time, amount = null, direction = direction, merchant = merchant)
    private fun receipt(id: String = "示例凭证", direction: String = "expense", merchant: String = "示例食堂", time: Long = now - 60_000) =
        PaymentEvent(eventId = id, source = "wechat", eventTime = time, amount = BigDecimal("12.50"), direction = direction,
            accountingType = "expense", merchant = merchant, status = "candidate")

    @Test fun everyStandardExtraCanSupplyAmount() {
        for (field in NotificationExtrasParser.fields + "vendor.payment_details") {
            val fields = if (field == "android.title") mapOf(field to listOf("示例数据 已支付￥12.50 商户：示例食堂"))
                else extras(field, "示例数据 已支付￥12.50 商户：示例食堂")
            val event = NotificationExtrasParser.parse(wechat, fields, now).single()
            assertEquals(field, BigDecimal("12.50"), event.amount)
            assertEquals(field, "expense", event.direction)
        }
    }
    @Test fun amountMayBeSplitAcrossFieldsAndAllLinesAreRead() {
        val event = NotificationExtrasParser.parse(wechat, mapOf("android.title" to listOf("微信支付"),
            "android.text" to listOf("支付成功"), "android.subText" to listOf("金额：￥12.50")), now).single()
        assertEquals(BigDecimal("12.50"), event.amount)
        val multiple = NotificationExtrasParser.parse(wechat, mapOf("android.title" to listOf("微信支付"),
            "android.textLines" to listOf("示例数据 已支付￥12.50 商户：示例甲", "示例数据 已支付￥9.90 商户：示例乙")), now)
        assertEquals(listOf(BigDecimal("12.50"), BigDecimal("9.90")), multiple.map { it.amount })
    }
    @Test fun repeatedRepresentationsAreNotSeparatePayments() {
        val text = "示例数据 已支付￥12.50 商户：示例食堂"
        val result = NotificationExtrasParser.parse(wechat, mapOf("android.title" to listOf("微信支付"),
            "android.text" to listOf(text), "android.bigText" to listOf(text), "android.messages" to listOf("text: $text")), now)
        assertEquals(1, result.size)
    }
    @Test fun opaqueWithdrawalAndIncomingTransferStayUnresolved() {
        val withdrawal = NotificationExtrasParser.parse(wechat, extras("android.text", "[2条]微信支付: 零钱提现已到账"), now).single()
        assertNull(withdrawal.amount)
        assertEquals("withdraw", withdrawal.direction)
        assertEquals("transfer", withdrawal.accountingType)
        assertEquals("unresolved", withdrawal.status)
        assertTrue(withdrawal.ambiguous)
        val collapsed = NotificationExtrasParser.parse(wechat, extras("android.text", "收到了10条消息"), now).single()
        assertTrue(collapsed.ambiguous)
        assertEquals("unresolved", collapsed.status)
        assertTrue(NotificationExtrasParser.parse(wechat, extras("android.text", "示例数据 欢迎使用"), now).isEmpty())
        val transfer = NotificationExtrasParser.parse(wechat, extras("android.text", "收到一笔转账"), now).single()
        assertEquals("transfer_in", transfer.direction)
        assertEquals("unresolved", transfer.status)
        assertTrue(NotificationExtrasParser.parse(wechat, extras("android.text", "示例数据 支付失败￥12.50"), now).isEmpty())
        assertTrue(NotificationExtrasParser.parse("com.example.chat", extras("android.text", "支付成功￥12.50"), now).isEmpty())
        assertTrue(NotificationExtrasParser.parse(alipay, mapOf("android.text" to listOf("支付成功")), now).isEmpty())
    }
    @Test fun withdrawalOwnAccountAndRefundOverrideOldIncomeExpenseHeuristics() {
        for (text in listOf("零钱提现已到账￥100.00", "收款到账￥100.00 本人账户转账", "支付成功￥100.00 同名账户转入")) {
            val event = NotificationExtrasParser.parse(wechat, extras("android.text", "示例数据 $text"), now).single()
            assertEquals(text, "transfer", event.accountingType)
            assertTrue(text, event.ownAccount)
        }
        val refund = NotificationExtrasParser.parse(alipay, mapOf("android.text" to listOf("示例数据 退款成功 金额：￥12.50")), now).single()
        assertEquals("refund", refund.direction)
        assertEquals("refund", refund.accountingType)
        for (text in listOf("零钱提现已到账￥-1.00", "零钱提现已到账￥12.345", "零钱提现已到账￥0.00")) {
            assertNull(NotificationExtrasParser.parseText(wechat, "wechat", text, now))
        }
        assertEquals("transfer_in", EventDirection.classify("示例数据 你已收款 转账").direction)
        assertEquals("transfer_out", EventDirection.classify("示例数据 转账成功").direction)
        assertEquals("expense", EventDirection.classify("示例数据 已发出的红包", "expense").direction)
    }
    @Test fun matcherRequiresTimeDirectionMerchantThenMutualUniqueness() {
        assertEquals(1, DeferredEventMatcher.match(listOf(pending()), listOf(receipt())).size)
        assertTrue(DeferredEventMatcher.match(listOf(pending()), listOf(receipt().copy(directionKnown = false))).isEmpty())
        assertTrue(DeferredEventMatcher.match(listOf(pending()), listOf(receipt(time = now - DeferredEventMatcher.WINDOW_MS - 1))).isEmpty())
        assertEquals(1, DeferredEventMatcher.match(listOf(pending()), listOf(receipt(time = now - DeferredEventMatcher.WINDOW_MS))).size)
        assertTrue(DeferredEventMatcher.match(listOf(pending(direction = "income")), listOf(receipt())).isEmpty())
        assertTrue(DeferredEventMatcher.match(listOf(pending(merchant = "示例书店")), listOf(receipt())).isEmpty())
        val a = receipt("示例甲凭证")
        val b = receipt("示例乙凭证", merchant = "示例书店", time = now - 2_000)
        // Closer in time is not proof: do not select b merely because it is newer.
        assertTrue(DeferredEventMatcher.match(listOf(pending()), listOf(a, b)).isEmpty())
        assertTrue(DeferredEventMatcher.match(listOf(pending("示例甲"), pending("示例乙")), listOf(a)).isEmpty())
        assertEquals(1, DeferredEventMatcher.match(listOf(pending(merchant = "示例书店")), listOf(a, b)).size)
        assertTrue(DeferredEventMatcher.match(listOf(pending().copy(ambiguous = true)), listOf(a)).isEmpty())
        assertTrue(DeferredEventMatcher.match(listOf(pending()), listOf(a.copy(source = "alipay"))).isEmpty())
    }
    @Test fun visibleReceiptsKeepAmountsMerchantsAndRealDatesTogether() {
        val messages = listOf("微信支付", "付款凭证", "付款金额", "￥12.50", "商户：示例食堂", "付款时间", "2026年10月31日 12:30:00",
            "收款凭证", "收款金额", "￥30.00", "付款方：示例甲", "收款时间", "今天 12:29")
        val result = DeferredReceiptParser.parse(messages, now, zone)
        assertEquals(2, result.size)
        assertEquals(listOf("expense", "income"), result.map { it.direction })
        assertEquals(listOf("示例食堂", "示例甲"), result.map { it.merchant })
        assertEquals(now - 60_000, result.first().eventTime)
        assertEquals(result.map { it.eventId }, DeferredReceiptParser.parse(messages, now, zone).map { it.eventId })
        assertTrue(DeferredReceiptParser.parse(messages.drop(1), now, zone).isEmpty())
        assertTrue(DeferredReceiptParser.parse(listOf("微信支付", "付款凭证", "付款金额￥12.50", "商户：示例食堂"), now, zone).isEmpty())
        assertNull(DeferredReceiptParser.visibleTime("示例数据 12:30", now, zone))
        val preceded = DeferredReceiptParser.parse(listOf("微信支付", "今天 12:30", "付款凭证", "付款金额￥12.50", "商户：示例食堂"), now, zone)
        assertEquals(now - 60_000, preceded.single().eventTime)
        assertNull(DeferredReceiptParser.visibleTime("示例数据 2026-02-30 12:30", now, zone))
        assertNull(DeferredReceiptParser.visibleTime("示例数据 今天 12:30 今天 12:29", now, zone))
        assertNull(DeferredReceiptParser.visibleTime("示例数据 今天 15:30", now, zone))
    }
}
