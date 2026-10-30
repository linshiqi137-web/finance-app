package com.xiaonagi.jizhang

import android.app.Notification
import android.os.Bundle
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

class PaymentNotificationListener : NotificationListenerService() {
    override fun onNotificationPosted(sbn: StatusBarNotification) {
        if (sbn.packageName !in PACKAGES) return
        val active = try { activeNotifications.orEmpty().filter { it.packageName in PACKAGES } } catch (_: Exception) { emptyList() }
        val snapshots = (listOf(sbn) + active).distinctBy { "${it.key}|${it.postTime}" }
        for (snapshot in snapshots) {
            try { inspect(snapshot, snapshot !== sbn, snapshots) } catch (_: Exception) {
                // Malformed OEM extras or persistence failures must not kill the listener.
            }
        }
    }

    private fun inspect(sbn: StatusBarNotification, scanned: Boolean, snapshots: List<StatusBarNotification>) {
        val notification = sbn.notification
        val extras = notification.extras ?: Bundle.EMPTY
        val summary = notification.flags and Notification.FLAG_GROUP_SUMMARY != 0
        val values = (extras.keySet() + NotificationExtrasParser.fields).associateWith { strings(extras.get(it)) }
        val diagnostics = JSONObject().put("captured_at", System.currentTimeMillis()).put("package", sbn.packageName)
            .put("key", sbn.key).put("groupKey", sbn.groupKey).put("postTime", sbn.postTime)
            .put("group_summary", summary).put("active_scan", scanned)
        val allExtras = JSONObject()
        for (key in extras.keySet().sorted()) allExtras.put(key, JSONArray(strings(extras.get(key))))
        // Include even absent standard fields so device-specific omissions can be diagnosed.
        for (key in NotificationExtrasParser.fields) if (!allExtras.has(key)) allExtras.put(key, JSONArray())
        diagnostics.put("extras", allExtras)
        val children = snapshots.filter { it.packageName == sbn.packageName && it.groupKey == sbn.groupKey &&
            it.notification.flags and Notification.FLAG_GROUP_SUMMARY == 0 }
        diagnostics.put("active_child_keys", JSONArray(children.map { it.key }))
        val events = if (summary && children.isNotEmpty()) emptyList() else NotificationExtrasParser.parse(sbn.packageName, values, sbn.postTime)
        diagnostics.put("parsed", JSONArray(events.map(TransactionQueue::json)))
        NotificationDiagnostics(this).append(diagnostics)
        val queue = TransactionQueue(this)
        for ((index, event) in events.withIndex()) {
            val identity = "${sbn.key}|${sbn.postTime}|$index|${event.amount}|${event.direction}"
            val stable = UUID.nameUUIDFromBytes(identity.toByteArray(Charsets.UTF_8)).toString()
            queue.capture(event.copy(eventId = stable, ambiguous = event.ambiguous || summary),
                values.values.flatten().distinct().joinToString("\n"), identity)
        }
    }

    /** Bundle/MessagingStyle arrays contain nested bundles, CharSequences, and sender metadata. */
    private fun strings(value: Any?, depth: Int = 0): List<String> {
        if (depth > 6 || value == null) return emptyList()
        return when (value) {
            is Bundle -> value.keySet().sorted().flatMap { key -> strings(value.get(key), depth + 1).map { "$key: $it" } }
            is Array<*> -> value.take(100).flatMap { strings(it, depth + 1) }
            is Iterable<*> -> value.take(100).flatMap { strings(it, depth + 1) }
            is CharSequence -> listOf(value.toString().take(16_384))
            is Number, is Boolean -> listOf(value.toString())
            else -> listOf("[${value.javaClass.simpleName}]")
        }
    }
    companion object { private val PACKAGES = setOf("com.tencent.mm", "com.eg.android.AlipayGphone") }
}
