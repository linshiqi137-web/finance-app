package com.xiaonagi.jizhang

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.webkit.JsResult
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.webkit.WebViewAssetLoader
import java.io.ByteArrayInputStream

class MainActivity : Activity() {
    private lateinit var webView: WebView
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pendingBackup: String? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        pendingBackup = savedInstanceState?.getString("pendingBackup")
        webView = WebView(this)
        setContentView(webView)
        // API 35 enforces edge-to-edge; apply system bar/keyboard insets to the WebView.
        webView.setOnApplyWindowInsetsListener { view, insets ->
            view.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop,
                insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
            insets
        }
        webView.requestApplyInsets()
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
        }
        webView.addJavascriptInterface(AndroidBridge(this), "AndroidBridge")
        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                return if (isAppAsset(request.url)) {
                    loader.shouldInterceptRequest(request.url) ?: blocked()
                } else blocked()
            }
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                !isAppAsset(request.url)
        }
        webView.webChromeClient = object : WebChromeClient() {
            override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: FileChooserParams): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = callback
                try {
                    startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = "*/*"
                    }, PICK_FILE)
                } catch (_: ActivityNotFoundException) {
                    fileCallback?.onReceiveValue(null)
                    fileCallback = null
                    message("未找到文件选择器")
                }
                return true
            }
            override fun onJsConfirm(view: WebView, url: String, message: String, result: JsResult): Boolean {
                AlertDialog.Builder(this@MainActivity).setMessage(message)
                    .setPositiveButton("确定") { _, _ -> result.confirm() }
                    .setNegativeButton("取消") { _, _ -> result.cancel() }
                    .setOnCancelListener { result.cancel() }.show()
                return true
            }
        }
        webView.loadUrl(START_URL)
    }

    override fun onResume() {
        super.onResume()
        if (::webView.isInitialized) {
            webView.onResume()
            webView.evaluateJavascript("window.onAndroidResume && window.onAndroidResume();", null)
        }
    }

    override fun onPause() { webView.onPause(); super.onPause() }

    override fun onSaveInstanceState(outState: Bundle) {
        pendingBackup?.let { outState.putString("pendingBackup", it) }
        super.onSaveInstanceState(outState)
    }

    fun openSettings(intent: Intent) = runOnUiThread {
        try { startActivity(intent) }
        catch (_: ActivityNotFoundException) { message("此设备未提供该设置页面，请在系统设置中手动开启。") }
    }

    fun saveBackup(json: String) = runOnUiThread {
        if (pendingBackup != null) return@runOnUiThread
        pendingBackup = json
        try {
            startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                addCategory(Intent.CATEGORY_OPENABLE)
                type = "application/json"
                putExtra(Intent.EXTRA_TITLE, "小凪记账-备份.json")
            }, SAVE_BACKUP)
        } catch (_: ActivityNotFoundException) {
            pendingBackup = null
            message("未找到文件保存器")
        }
    }

    @Deprecated("Used for API 26-compatible document picker")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == PICK_FILE) {
            fileCallback?.onReceiveValue(if (resultCode == RESULT_OK) data?.data?.let { arrayOf(it) } else null)
            fileCallback = null
        } else if (requestCode == SAVE_BACKUP) {
            val backup = pendingBackup
            pendingBackup = null
            if (resultCode == RESULT_OK && data?.data != null && backup != null) {
                try {
                    val output = contentResolver.openOutputStream(data.data!!, "wt") ?: error("无法打开文件")
                    output.bufferedWriter(Charsets.UTF_8).use { it.write(backup) }
                    message("备份已保存")
                } catch (_: Exception) { message("备份保存失败，请重试") }
            }
        }
    }

    @Deprecated("Used for API 26-compatible back navigation")
    override fun onBackPressed() {
        webView.evaluateJavascript("document.querySelector('[data-tab=home]').click();", null)
    }

    override fun onDestroy() {
        fileCallback?.onReceiveValue(null)
        webView.removeJavascriptInterface("AndroidBridge")
        webView.destroy()
        super.onDestroy()
    }

    private fun message(text: String) = Toast.makeText(this, text, Toast.LENGTH_LONG).show()
    private fun isAppAsset(uri: Uri) = uri.scheme == "https" && uri.host == WebViewAssetLoader.DEFAULT_DOMAIN &&
        uri.port == -1 && uri.path.orEmpty().startsWith("/assets/")
    private fun blocked() = WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))

    companion object {
        private const val START_URL = "https://appassets.androidplatform.net/assets/index.html"
        private const val PICK_FILE = 1
        private const val SAVE_BACKUP = 2
    }
}
