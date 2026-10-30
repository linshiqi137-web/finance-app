package com.xiaonagi.jizhang

import org.junit.Assert.*
import org.junit.Test
import java.math.BigDecimal

class PaymentDeduperTest {
    // 示例数据 / example data: fictional captures from two independent services.
    @Test fun notificationAndAccessibilityShareSourceAmountDirectionKey() {
        val notification = PaymentParser.parse("com.tencent.mm", "已支付￥12.50 商户：示例食堂")!!
        val screen = AccessibilityPaymentParser.parse("com.tencent.mm", listOf("支付成功", "¥12.50", "示例食堂"))!!
        val first = PaymentDeduper.check(emptyList(), PaymentDeduper.key(notification.source, notification.amount, notification.type), 1_000)
        val second = PaymentDeduper.check(first.recent, PaymentDeduper.key(screen.source, screen.amount, screen.type), 2_000)
        assertFalse(first.duplicate)
        assertTrue(second.duplicate)
        assertEquals(first.recent, second.recent)
    }

    @Test fun sourceAndDirectionRemainIndependentAndAmountIsCanonical() {
        val key = PaymentDeduper.key("wechat", BigDecimal("12.5"), "expense")
        assertEquals(key, PaymentDeduper.key("wechat", BigDecimal("12.50"), "expense"))
        val first = PaymentDeduper.check(emptyList(), key, 1_000)
        for (other in listOf(PaymentDeduper.key("alipay", BigDecimal("12.50"), "expense"),
            PaymentDeduper.key("wechat", BigDecimal("12.50"), "income"),
            PaymentDeduper.key("wechat", BigDecimal("12.51"), "expense"))) {
            assertFalse(PaymentDeduper.check(first.recent, other, 2_000).duplicate)
        }
    }

    @Test fun threeMinuteBoundaryAndNoSlidingExtension() {
        val first = PaymentDeduper.check(emptyList(), "example", 1_000)
        assertTrue(PaymentDeduper.check(first.recent, "example", 180_999).duplicate)
        val boundary = PaymentDeduper.check(first.recent, "example", 181_000)
        assertTrue(boundary.duplicate)
        assertFalse(PaymentDeduper.check(boundary.recent, "example", 181_001).duplicate)
        assertEquals(1, PaymentDeduper.check(boundary.recent, "example", 181_001).recent.size)
    }

    @Test fun restoredSnapshotStillSuppressesAfterQueueAcknowledgement() {
        val first = PaymentDeduper.check(emptyList(), "example", 1_000)
        // Queue ack changes pending records only; persist/restore retains these two fields.
        val restored = first.recent.map { PaymentDeduper.Entry(it.key, it.seenAt) }
        assertTrue(PaymentDeduper.check(restored, "example", 2_000).duplicate)
        assertFalse(PaymentDeduper.check(restored, "example", 181_001).duplicate)
    }

    @Test fun expiredAndFutureEntriesDoNotSuppressAfterClockChanges() {
        val recent = listOf(PaymentDeduper.Entry("example", 1_000), PaymentDeduper.Entry("future", 999_999))
        val result = PaymentDeduper.check(recent, "example", 200_000)
        assertFalse(result.duplicate)
        assertEquals(listOf(PaymentDeduper.Entry("example", 200_000)), result.recent)
    }
}
