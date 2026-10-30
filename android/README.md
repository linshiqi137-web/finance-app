# 小凪记账 Android v0.3.0

Kotlin Android APK，应用 ID `com.xiaonagi.jizhang`，版本 `0.3.0`（versionCode 3），最低 Android 8.0（API 26），目标与编译 SDK 35。`/workspace/finance-app/android` 是本仓库 `android/` 的符号链接。

## 构建

本环境已安装 Temurin JDK 17 至 `~/.local/share/jizhang-jdk`，Android SDK 至 `~/android-sdk`，包含 platforms;android-35、build-tools;35.0.0。`local.properties` 已指向本机 SDK，并由 `.gitignore` 排除。

```sh
cd /workspace/finance-app/app/android
export JAVA_HOME="$HOME/.local/share/jizhang-jdk"
export PATH="$JAVA_HOME/bin:$HOME/android-sdk/platform-tools:$PATH"
./gradlew testDebugUnitTest assembleDebug
```

Gradle wrapper 8.9（含官方分发 SHA-256）、Android Gradle Plugin 8.7.3、Kotlin 2.0.21，依赖固定版本。其他电脑可用任意 JDK 17，并在 `android/local.properties` 设置 `sdk.dir=/绝对路径/android-sdk`。

生成文件：`app/build/outputs/apk/debug/app-debug.apk`，使用开发密钥签名。交付副本：`/workspace/finance-app/dist/xiaonagi-jizhang.apk`。

`bundlePwa` 每次构建从仓库根目录同步 `index.html`、`js/`、`styles.css`、`icon.svg`、`manifest.webmanifest` 至生成的 assets。源网页只有一份；不打包 `sw.js`，AndroidBridge 存在时跳过 Service Worker 注册。WebViewAssetLoader 使用 `https://appassets.androidplatform.net/assets/index.html`，保持固定的 localStorage 来源。

## 使用与本地数据

1. 首次打开后点击「开启无障碍自动记账」，在系统设置开启「小凪记账 · 支付页面自动记账」。卡片与设置页显示开启状态，返回应用时刷新。
2. 可授予通知使用权作为补充；按设备需要关闭电池优化、允许自启动。首次系统授权需手动完成，之后无需录入金额。无障碍只识别已显示的页面，不会打开微信、点击收款或操作屏幕。
3. 页面识别结果与通知共用本机 SharedPreferences 队列；打开或返回应用时自动写入账本。明细显示「微信／支付宝」和「自动」，可编辑金额、类型、分类和备注。
4. 设置页可再次打开无障碍、通知使用权与电池设置。CSV／JSON 导入和备份使用系统文件选择器，无需文件存储权限。

无障碍只监听 `com.tencent.mm`、`com.eg.android.AlipayGphone` 的窗口内容／状态变化，读取可见节点文字，不请求手势能力。系统事件合并间隔 300 ms，遍历间隔至少 600 ms，最多遍历 512 个节点、40 层、约 32 KiB 文字。节点用完即释放，不保存整个聊天窗口。通知监听只处理这两个包的非分组摘要通知，不扫描历史通知，不连接支付账户。

数据只保存在本机，应用没有 INTERNET 权限，WebView 阻止外部加载，Android 自动备份已关闭。浏览器与 APK 的存储独立，可用 JSON 备份迁移；浏览器没有 Android 无障碍能力。清除应用数据或卸载会删除本机数据，请定期导出备份。

## 解析与去重

`AccessibilityPaymentParser.kt` 接受包名与有序 `List<String>`，无 Android 依赖，输出金额、expense/income 方向、商户／对方、wechat/alipay 来源。支持人民币符号、元、千位分隔、全角数字，以及金额／币种分开的节点。`parseAll` 可识别同一微信支付消息窗口内的多条凭证。通知先尝试新解析器，再回退 `PaymentParser.kt`。

- 微信支付成功，支付宝支付成功／付款成功／转账成功 → 支出。
- 微信转账待对方收款／对方已收款／你向对方转账 → 支出；你已收款／接收详情的已收款 → 收入；待你收款／确认收款不入账。
- 微信支付凭证「付款金额」→ 支出，「收款金额」→ 收入，按凭证提取商户与金额。
- 已发出的微信红包 → 支出，未发送和收到的红包跳过。
- 通知补充支持已支付／付款¥／收款到账／向你转账等描述；方向不明的一般转账通知保留 transfer 类型，不参与收支合计。无障碍方向不明的转账页面跳过。
- 失败、待支付、退款等提示跳过；没有金额时不推测金额。

`PaymentDeduper.kt` 按来源 + 两位小数金额 + 收支方向去重，窗口为三分钟。两个捕获服务共用队列锁与持久化摘要，确认队列不删除摘要，重启进程后仍有效；重复事件不延长原始窗口。三分钟内同来源、同金额、同方向的不同真实交易也会被合并，这是跨通知与页面去重的明确取舍。

网页沿用稳定队列 ID，批次验证后一次写入 localStorage，存储成功才 ack。保存后退出或 ack 失败，再次读取不会重复插入或覆盖编辑。通知保留原文；无障碍仅保存解析后的来源、方向、金额与商户摘要。备注用 textContent 渲染。

商户、分类由文字推测；隐藏金额、未显示的页面、平台未提供无障碍文字、页面格式变化或厂商后台限制仍可能导致漏记。首次启用后显示的历史微信支付凭证也可能被捕获，日期为捕获时间。

## 测试

```sh
# 仓库根目录：全部 Web 测试
node --test tests/*.mjs
# android 目录：纯 Kotlin JUnit + APK
./gradlew testDebugUnitTest assembleDebug
```

解析与去重测试使用标注的「示例数据 / example data」，覆盖支付、转账方向、多条凭证、红包、非法金额、跨渠道去重、三分钟边界及恢复后的摘要。仍需在真实手机上验证微信／支付宝页面节点、通知投递与厂商电池管理行为。
