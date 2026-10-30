# 小凪记账 Android v0.4.0

应用 ID `com.xiaonagi.jizhang`，版本 `0.4.0`（versionCode 4），最低 Android 8.0（API 26），目标与编译 SDK 35。PWA 源码仍在仓库根目录，Android 在 `android/`；`/workspace/finance-app/android` 是本目录的符号链接。

## 构建与签名

```sh
cd /workspace/finance-app/app/android
export JAVA_HOME="$HOME/.local/share/jizhang-jdk"
export PATH="$JAVA_HOME/bin:$HOME/android-sdk/platform-tools:$PATH"
./gradlew testDebugUnitTest assembleDebug
```

本环境使用 JDK 17、Gradle wrapper 8.9、AGP 8.7.3、Kotlin 2.0.21、SDK/build-tools 35。其他电脑在 `android/local.properties` 设置 `sdk.dir=/绝对路径/android-sdk`。

生成 `app/build/outputs/apk/debug/app-debug.apk`，交付副本 `/workspace/finance-app/dist/xiaonagi-jizhang.apk`。继续使用 v0.3.0 的 **`/home/box/.android/debug.keystore`**、别名 `AndroidDebugKey`，不生成新密钥。已比对旧 APK、Gradle signingReport 和新 APK：证书 SHA-256 均为 `97081e0a16271d1fba56fcf32c3e17243c964c9bb9b8922b9e78fdc6fd510fd7`，可覆盖升级保留应用数据。密钥不提交到仓库；在其他机器构建要自行安全迁移同一密钥，才能覆盖安装。

```sh
$HOME/android-sdk/build-tools/35.0.0/aapt dump badging /workspace/finance-app/dist/xiaonagi-jizhang.apk
$HOME/android-sdk/build-tools/35.0.0/aapt dump permissions /workspace/finance-app/dist/xiaonagi-jizhang.apk
$HOME/android-sdk/build-tools/35.0.0/apksigner verify --print-certs /workspace/finance-app/dist/xiaonagi-jizhang.apk
```

没有 `INTERNET` 权限。`bundlePwa` 从根目录同步网页资源，Android 使用固定的 WebViewAssetLoader HTTPS 本地来源，阻止外部加载、不注册 Service Worker、关闭系统自动备份。CSV/JSON 使用系统文件选择器，无需文件存储权限。

## 手机使用与诊断入口

1. 首次打开，点「开启无障碍自动记账」，在系统设置中开启对应服务；通知使用权是补充，厂商设备可按需允许自启动和关闭电池优化。
2. v0.3 的支付成功、转账、已发红包、微信支付凭证识别和共享三分钟去重继续工作。两个旧解析器的金额及成功状态规则不变，只增加临时凭证上下文供事件方向分类使用。
3. 微信通知没有金额时，在首页显示「待补全」，**不计入任何收支、预算或分类统计**。用户自行打开微信支付服务号聊天或消息列表，让最新支付消息、金额及明确时间可见，再返回本应用。无障碍只读取当前前台窗口，绝不自动打开微信、导航、点击或滚动。
4. 待补全中方向明确的记录也可手动填写金额；金额先保存到网页，再通知原生停止该事件的后续补全。失败可重试，迟到的原生补全不会重复计数。方向不明确时保留待补全，等待明确凭证或自行手动记账。
5. **打开隐藏「诊断」：设置 → 支付自动记账 → 连续点击 `v0.4.0` 五次**（相邻点击间隔小于 1.5 秒）。诊断页可刷新、复制通知诊断和清空通知诊断，同时显示网页保存的事件状态。复制按钮只复制最近的原生通知快照；点击后内容进入系统剪贴板，不会自动发送给任何人。

诊断默认保留最近 **50 条快照**，包括通知到达和活动通知扫描。读取微信、支付宝全部 extras 键，包括 `TITLE`、`TEXT`、`BIG_TEXT`、`TEXT_LINES`、`SUB_TEXT`、`SUMMARY_TEXT`、`MESSAGES`，递归读取消息 Bundle/数组，另含 `groupKey`、`key`、`postTime`、是否分组摘要、是否来自活动扫描、同组子通知 key 及解析结果。每次通知到达都会检查 `getActiveNotifications()`；同组子通知存在时优先处理子通知，不把摘要作为另一笔交易。

原始诊断只在应用私有 SharedPreferences 中保存，不写 Logcat、不联网、不进入 JSON 账本备份；可能包含通知中的私人消息及交易信息。数组最多读取 100 项、递归最多 6 层、单段文字最多 16 KiB，超出内容截断；无法转换的系统对象只记录类型名。清空诊断不删除账目或待补全事件。无障碍不保存整个聊天窗口，只保存解析后的交易摘要。

## 事件、匹配和统计

原生 `PaymentEvent` 和网页自动记录使用：

| 字段 | 含义 |
| --- | --- |
| `event_id` | 稳定事件 ID，区别于每次队列投递的 `id` |
| `source` | `wechat` / `alipay` |
| `event_time` | 通知 postTime 或可见凭证时间，Unix 毫秒 |
| `amount` | 正金额；未知为 `null`，不以 0 或估计值代替 |
| `merchant` | 可提取的商户/对方，未知为空 |
| `direction` | `expense` / `income` / `transfer_in` / `transfer_out` / `refund` / `withdraw` |
| `confidence` | `high` / `low` |
| `status` | `candidate` / `confirmed` / `unresolved` / `reconciled` / `duplicate` |
| `matched_event_id` | 关联凭证/通知/重复事件 ID，未关联为 `null` |

保留旧的 `type` 等字段兼容原账本。提现、明确本人/同名账户和零钱通/余额宝内部划转强制为 `transfer`，永不计支出或收入，CSV 导入同样处理。外部转账保留 v0.3 规则：明确转入/已收款计收入、明确转出计支出；方向不明的一般转账不计收支。退款抵扣消费。统计只接收 `confirmed` 事件；v0.3 与手动/CSV 旧记录没有 status 字段时沿用原统计。

`DeferredReceiptParser` 从微信支付凭证卡片或服务号消息列表项提取金额、商户及消息时间；列表项按节点子树限定，不拼接相邻私人聊天。支持完整 `YYYY-MM-DD HH:mm[:ss]` / `YYYY年M月D日 HH:mm[:ss]`，以及明确的「今天/昨天 HH:mm[:ss]」。**单独 HH:mm、不明确日期、无时间、多时间冲突和未来时间不作自动补全**，不会把打开微信的时间当作消息时间。

`DeferredEventMatcher` 先限定来源和 **前后十分钟**，再按已知方向、已知商户精确筛选，要求通知→凭证和凭证→通知都唯一。多个可能项不会按“最近一条”猜测；合并通知、相同凭证重复出现也不自动拆分或猜测。匹配成功后，原通知为 `reconciled`，凭证为 `confirmed`，互相记录 ID，仅凭证进入统计。补全候选在存在待补全的服务号窗口里不会旁路进入旧自动入账路径。完整通知也可关联先前无金额通知。

`PaymentDeduper` 仍按来源 + 两位小数金额 + 旧收支类型去重，三分钟窗口不滑动，跨两个服务、ack 和进程重启保留。原生队列的投递 ID 每次变更唯一，旧 ack 不会删除并发的新状态；未完成事件在原生档案中持久保留，ack 只移除已交付队列项。原生保留最近 1000 条已结束事件和 1000 个通知身份用于去重，不清除未完成项。网页一次写入 localStorage 成功后才 ack，保留终态与用户编辑，兼容升级时混合的新旧队列。JSON 备份包含事件及状态，继续接受旧 version 1 备份。

## 测试与限制

```sh
# 仓库根目录
node --test tests/*.mjs
# Android 目录
./gradlew testDebugUnitTest assembleDebug
```

JVM 测试覆盖七类 extras 和自定义字段、分拆字段、多消息/重复表示、无金额通知、提现/本人账户/退款方向、非法金额、匹配时间边界、双向歧义、来源与商户、真实可见时间，以及全部 v0.3 解析与去重测试。Web 测试覆盖未完成排除、补全状态迁移、保存/ack 重放、混合队列升级、手填与迟到事件、备份、提现排除和既有预算/CSV 行为。浏览器交互测试额外验证普通 PWA、模拟 AndroidBridge、诊断入口/复制/清空和移动端布局；自动查找 Chromium，也可设 `CHROME_BIN`，未安装浏览器时仅该项跳过。所有样本明确标注「示例数据 / example data」，不在启动时写入账本。

已在此环境执行 JVM、Web、浏览器测试及 APK 构建、aapt/签名检查；没有连接 Android 真机，无法验证实际微信/支付宝版本的节点、锁屏通知隐私及厂商后台策略。平台若根本不提供金额，诊断也无法恢复隐藏信息。仅有合并摘要、日期不完整、超出匹配窗口或匹配不唯一时会继续待补全；需自行显示更明确凭证或手动录入。三分钟内同来源、同金额、同收支类型的不同真实交易仍可能被旧去重合并。无待补全时的旧服务号历史凭证捕获行为保留，仍可能以当前捕获时间记账，请核对明细。
