package com.xiaonagi.jizhang

import android.content.ComponentName
import android.content.Intent
import android.content.Context
import android.accessibilityservice.AccessibilityServiceInfo
import android.provider.Settings
import android.view.accessibility.AccessibilityManager
import android.webkit.JavascriptInterface

class AndroidBridge(private val activity: MainActivity) {
    private val queue = TransactionQueue(activity)

    @JavascriptInterface
    fun getPendingTransactions(): String = queue.pending()

    @JavascriptInterface
    fun ackTransactions(idsJson: String) { queue.ack(idsJson) }

    @JavascriptInterface
    fun isNotificationAccessGranted(): Boolean {
        val enabled = Settings.Secure.getString(activity.contentResolver, "enabled_notification_listeners").orEmpty()
        val listener = ComponentName(activity, PaymentNotificationListener::class.java)
        return enabled.split(':').any { ComponentName.unflattenFromString(it) == listener }
    }

    @JavascriptInterface
    fun openNotificationSettings() {
        activity.openSettings(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
    }

    @JavascriptInterface
    fun isAccessibilityServiceEnabled(): Boolean {
        val manager = activity.getSystemService(Context.ACCESSIBILITY_SERVICE) as AccessibilityManager
        val target = ComponentName(activity, PaymentAccessibilityService::class.java)
        return manager.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK).any {
            val service = it.resolveInfo.serviceInfo
            ComponentName(service.packageName, service.name) == target
        }
    }

    @JavascriptInterface
    fun openAccessibilitySettings() {
        activity.openSettings(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
    }

    @JavascriptInterface
    fun openBatterySettings() {
        activity.openSettings(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
    }

    @JavascriptInterface
    fun getNotificationDiagnostics(): String = NotificationDiagnostics(activity).read()

    @JavascriptInterface
    fun clearNotificationDiagnostics() { NotificationDiagnostics(activity).clear() }

    @JavascriptInterface
    fun copyNotificationDiagnostics() = activity.runOnUiThread {
        val clipboard = activity.getSystemService(Context.CLIPBOARD_SERVICE) as android.content.ClipboardManager
        clipboard.setPrimaryClip(android.content.ClipData.newPlainText("支付通知诊断", NotificationDiagnostics(activity).read()))
    }

    @JavascriptInterface
    fun resolvePaymentEvent(eventId: String, amount: String) { queue.resolve(eventId, amount) }

    @JavascriptInterface
    fun saveBackup(json: String) { activity.saveBackup(json) }
}
