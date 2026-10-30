package com.xiaonagi.jizhang

import android.accessibilityservice.AccessibilityService
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

class PaymentAccessibilityService : AccessibilityService() {
    private val handler = Handler(Looper.getMainLooper())
    private var scheduled = false
    private var lastTraversal = -THROTTLE_MS
    private val capture = Runnable {
        scheduled = false
        lastTraversal = SystemClock.uptimeMillis()
        captureWindow()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event == null || event.packageName?.toString() !in PACKAGES) return
        if (event.eventType != AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED &&
            event.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) return
        if (scheduled) return
        scheduled = true
        handler.postDelayed(capture, (THROTTLE_MS - (SystemClock.uptimeMillis() - lastTraversal)).coerceAtLeast(0))
    }

    private fun captureWindow() {
        // Never retain nodes or raw screen contents between traversals, or inspect other apps.
        val root = rootInActiveWindow ?: return
        try {
            val packageName = root.packageName?.toString() ?: return
            if (packageName !in PACKAGES) return
            val texts = mutableListOf<String>()
            var visited = 0
            var characters = 0
            fun visit(node: AccessibilityNodeInfo, depth: Int) {
                if (++visited > 512 || depth > 40 || characters >= 32_768) return
                if (node.packageName?.toString()?.let { it !in PACKAGES } == true) return
                if (node.isVisibleToUser) {
                    val text = (node.text?.toString()?.takeIf(String::isNotBlank)
                        ?: node.contentDescription?.toString()).orEmpty().take(4096)
                    if (text.isNotBlank()) { texts.add(text); characters += text.length }
                }
                for (index in 0 until node.childCount) {
                    if (visited >= 512 || characters >= 32_768) break
                    val child = node.getChild(index) ?: continue
                    try { visit(child, depth + 1) } finally { child.recycle() }
                }
            }
            visit(root, 0)
            val queue = TransactionQueue(this)
            for (payment in AccessibilityPaymentParser.parseAll(packageName, texts)) {
                // Store only the parsed receipt, not the whole chat/service-account window.
                val receipt = "${payment.source} ${payment.type} ¥${payment.amount} ${payment.merchant}"
                queue.enqueue(packageName, receipt, payment, System.currentTimeMillis())
            }
        } catch (_: Exception) {
            // Windows can disappear mid-traversal; a later event will retry. No screen text is logged.
        } finally { root.recycle() }
    }

    override fun onInterrupt() { cancelCapture() }
    override fun onDestroy() { cancelCapture(); super.onDestroy() }
    private fun cancelCapture() { handler.removeCallbacks(capture); scheduled = false }

    companion object {
        private const val THROTTLE_MS = 600L
        private val PACKAGES = setOf("com.tencent.mm", "com.eg.android.AlipayGphone")
    }
}
