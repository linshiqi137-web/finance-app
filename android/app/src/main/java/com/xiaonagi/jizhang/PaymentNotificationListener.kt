package com.xiaonagi.jizhang

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

class PaymentNotificationListener : NotificationListenerService() {
    override fun onNotificationPosted(sbn: StatusBarNotification) {
        if (sbn.packageName !in setOf("com.tencent.mm", "com.eg.android.AlipayGphone")) return
        if (sbn.notification.flags and Notification.FLAG_GROUP_SUMMARY != 0) return
        val extras = sbn.notification.extras
        // Prefer bigText over text: they often repeat the very same payment.
        val body = extras.getCharSequence(Notification.EXTRA_BIG_TEXT)?.toString()?.takeIf { it.isNotBlank() }
            ?: extras.getCharSequence(Notification.EXTRA_TEXT)?.toString().orEmpty()
        val lines = extras.getCharSequenceArray(Notification.EXTRA_TEXT_LINES)?.joinToString("\n").orEmpty()
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString().orEmpty()
        val text = listOf(title, body.ifBlank { lines }).filter { it.isNotBlank() }.distinct().joinToString("\n")
        val payment = PaymentParser.parse(sbn.packageName, text) ?: return
        // No raw notification content is logged, transmitted, or sent to another app.
        try {
            TransactionQueue(this).enqueue(sbn.packageName, text, payment, sbn.postTime)
        } catch (_: Exception) {
            // Leave the service alive if the device cannot persist a notification.
        }
    }
}
