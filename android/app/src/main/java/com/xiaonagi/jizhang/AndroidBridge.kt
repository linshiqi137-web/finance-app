package com.xiaonagi.jizhang

import android.content.ComponentName
import android.content.Intent
import android.provider.Settings
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
    fun openBatterySettings() {
        activity.openSettings(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
    }

    @JavascriptInterface
    fun saveBackup(json: String) { activity.saveBackup(json) }
}
