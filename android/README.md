# 小凪记账 Android（Phase 2）

Kotlin Android APK，应用 ID `com.xiaonagi.jizhang`，最低 Android 8.0（API 26），目标与编译 SDK 35。

## 构建

已在本环境安装 Temurin JDK 17 至 `~/.local/share/jizhang-jdk`、Android SDK 至 `~/android-sdk`，接受 SDK 许可，并安装 platform-tools、platforms;android-35、build-tools;35.0.0。`local.properties` 已指向本机 SDK，并由仓库根目录 `.gitignore` 排除。

```sh
cd /workspace/finance-app/app/android
export JAVA_HOME="$HOME/.local/share/jizhang-jdk"
export PATH="$JAVA_HOME/bin:$HOME/android-sdk/platform-tools:$PATH"
./gradlew testDebugUnitTest assembleDebug
```

Gradle wrapper 8.9（含官方分发 SHA-256）、Android Gradle Plugin 8.7.3、Kotlin 2.0.21，依赖固定版本。其他电脑可用任意 JDK 17，并在 `android/local.properties` 设置 `sdk.dir=/绝对路径/android-sdk`。

生成文件：`app/build/outputs/apk/debug/app-debug.apk`。这是使用开发密钥签名的调试 APK。本次交付副本位于 `/workspace/finance-app/dist/xiaonagi-jizhang.apk`。

`bundlePwa` 是 Gradle Sync 任务，每次构建从仓库根目录同步 `index.html`、`js/`、`styles.css`、`icon.svg`、`manifest.webmanifest` 至生成的 assets 目录。源网页始终只有一份；不打包 `sw.js`，AndroidBridge 存在时网页跳过 Service Worker 注册。WebViewAssetLoader 使用 `https://appassets.androidplatform.net/assets/index.html`，启用 JavaScript、DOM storage，保持固定的 localStorage 来源。

## 使用与本地数据

1. 安装 APK，首次打开后点击「授予通知使用权」，在系统页面允许「小凪记账」。
2. 在电池设置关闭电池优化；在厂商系统设置中允许自启动。保持微信与支付宝通知开启，并允许显示通知内容。
3. 支付通知先进入本机 SharedPreferences 队列；打开或返回应用时自动写入账本，再确认队列。明细显示「微信／支付宝」和「自动」，可编辑金额、类型、分类和备注。
4. 设置页可再次打开通知使用权、电池设置。CSV／JSON 导入使用系统文件选择器；JSON 备份使用系统文件保存器，无需文件存储权限。

只处理 `com.tencent.mm` 和 `com.eg.android.AlipayGphone` 的非分组摘要通知；不扫描历史通知，不连接支付账户。所有数据保存在本机，没有 INTERNET 权限，WebView 也阻止外部加载，Android 自动备份已关闭。浏览器版与 APK 的存储独立，可用 JSON 备份迁移。清除应用数据或卸载会删除本机数据，请定期导出备份。

## 解析与去重规则

`PaymentParser.kt` 无 Android 依赖。支持人民币符号、元、千位分隔、全角数字，输出来源、expense/income/transfer、金额、可提取商户、high/low 置信度。直接匹配金额为 high，成功提示中独立金额为 low。商户和分类由文本推测，不保证支付平台通知格式变化后仍能识别。

- 已支付／支付成功／付款成功／付款¥／你已成功付款 → 支出。
- 收款到账／收款￥／已收款／向你转账 → 收入。
- 只有一般「转账」描述 → 转账，不参与收支合计；方向不明时可在明细中修正。
- 失败、待支付、退款等提示跳过；不把退款误记为支出。
- 按包名 + 两位小数金额 + 标准化空白后的完整通知文本，保留两分钟的去重摘要；确认队列不会删除摘要。
- 不同文本的同额通知可能形成多笔记录；两分钟内完全相同的真实支付可能被合并，请核对。厂商后台限制、通知隐藏金额或非通知渠道可能导致漏记。

网页入账使用稳定通知 ID，整个批次验证后一次写入 localStorage，存储成功才 ack。若写入后进程退出或 ack 失败，再次读取不会重复插入，也不会覆盖已编辑的记录。原始通知文本作为备注保存在账目中；备注渲染使用 textContent。

## 测试

```sh
# 仓库根目录：原有测试与通知入账可靠性测试
node --test tests/*.mjs
# android 目录：纯 Kotlin 解析器 JUnit + APK
./gradlew testDebugUnitTest assembleDebug
```

测试通知均为标注的「示例数据 / example data」。仍需在实际手机上开启通知使用权并检查微信、支付宝通知投递和厂商电池管理行为。
