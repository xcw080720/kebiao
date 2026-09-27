# 课表 kebiao

一个安卓课表 App：把**课表截图 / Excel / Word / CSV / 纯文字**丢进去，交给**你自己配置的**「OpenAI 兼容」大模型整理成结构化课程，核对完点一下才写进课表。每门课可以单独设「提前多少分钟提醒」。

没有 Gradle、没有 Maven、没有任何在线依赖——构建走 `aapt → javac → d8 → aapt → zipalign → apksigner` 的手工流水线。

## 功能

- **导入**：截图/照片（视觉模型）、`.xlsx`、`.docx`、`.csv`/`.txt`（UTF-8 / GBK 自动判断）、直接粘贴文字
- **草稿核对**：AI 结果先渲染成可编辑表单，逐条改完再点「追加到课表」，不会直接覆盖
- **课表**：「今天」列表 / 周视图，支持连续周、单双周、指定周（如 `1,3,5`）
- **提醒**：每门课可设提前量，`AlarmManager` 精确闹钟 + 通知，重启后由 `BOOT_COMPLETED` 重排
- **假期 / 停课日**：一行一条，`国庆 2026-10-01 ~ 2026-10-07`；这些天课表不显示、闹钟也不排
- **对话改课表**：直接跟模型说话（「把周三的高数挪到周四」），它先给一份改动清单，**点了「应用」才真的改**
- **手动录入**：周视图右上角「＋」直接建课
- 全部本地存储，课表是 App 私有目录里的一个 JSON

## 它是怎么「看懂」的

```
截图 ──► Java 侧解码/缩放（最长边 1600，JPEG q85）
文档 ──► Java 侧零依赖解析出文字（xlsx / docx / csv）
                    │
                    ▼
        发给你在「设置 → AI 识别」里填的接口
                    │
                    ▼
        模型返回 JSON ──► 本地渲染成可编辑草稿
```

- 默认接口 `https://api.deepseek.com/v1`，默认模型 `deepseek-chat`；任何 OpenAI 兼容端点都能用
- **材料内容（截图 / 文档文字）会发送到你填的那个接口**——请知情后再用
- API Key 只存在手机本机（App 私有 SharedPreferences），不在代码里、不随仓库分发
- 不传 `max_tokens`：带推理的模型会把额度全烧在思考上，正文就空了（踩过这个坑，写在这里备忘）

## 格式支持

| 格式 | 支持 | 备注 |
| --- | --- | --- |
| 图片 `.jpg/.png/.webp/.heic…` | ✅ | 走视觉模型；先本地缩放再上传 |
| `.xlsx` | ✅ | 共享字符串表 + 合并单元格 + 保留列序号 |
| `.docx` | ✅ | |
| `.csv` / `.txt` | ✅ | UTF-8 优先，失败回退 GBK |
| `.pdf` / `.xls` / `.doc` | ❌ | 老格式与 PDF 不支持，会明确告知 |

## 构建

需要 JDK 17 + Android SDK（build-tools、platform）。构建脚本 `build-apk.ps1` 已随仓库附带，是从零手写的一体化打包器：

```powershell
$env:JAVA_HOME = 'D:\AndroidSDK\jdk17'
$env:ANDROID_HOME = 'D:\AndroidSDK'
.\build-apk.ps1 -Project . -MinApi 23 -Platform android-35 -BuildTools 34.0.0
```

产物落在 `build/kebiao.apk`。签名默认用 `%USERPROFILE%\.android\debug.keystore`（可用 `-Keystore/-KsAlias/-KsPass` 换）。

`dist/kebiao.apk` 是随手构建的一份，方便直接装来试。

> `AndroidManifest.xml` 里留了 `android:debuggable="true"`。这是刻意留的：部分国行 ROM（实测 vivo / OriginOS）抓不到第三方应用的 logcat，App 会把每次 AI 调用的诊断写进私有目录的 `files/ai_last.txt`，靠 `adb shell run-as com.xcw.kebiao cat files/ai_last.txt` 读回来。**不需要这个能力的话删掉那一行即可。**

## 目录结构

```
AndroidManifest.xml
src/com/xcw/kebiao/
    MainActivity.java   WebView 壳 + @JavascriptInterface 桥（Native.xxx）
    Ai.java             OpenAI 兼容接口调用、图片压缩成 data URL
    OfficeParser.java   零依赖解析 xlsx / docx / csv（不依赖任何第三方库）
    Scheduler.java      闹钟排期（AlarmManager）+ 通知
    Store.java          轻量 JSON 持久化
    ReminderReceiver.java / BootReceiver.java
assets/www/             UI（index.html / app.js / style.css），纯前端零依赖
res/                    图标与字符串
build-apk.ps1           手工构建流水线
check-ui.js             用 playwright-core 驱动 Edge 给 UI 截图（开发自检用）
make-icon.ps1           生成图标
testdata/               解析器的测试素材
```

设计上刻意做了分工：**时间计算全部在 JS 里**，Java 只负责「到点的时候把通知弹出来」。JS 算出「第 T 毫秒要响一次」的列表交给 Java，Java 只调 `AlarmManager.setExactAndAllowWhileIdle` + `NotificationManager`。这样加节假日、调课这类功能不用动 Java。

## 提醒可靠性

- `RTC_WAKEUP` 精确闹钟（`setExactAndAllowWhileIdle`），休眠也能响
- Android 12+ 需要「闹钟与提醒」权限（`SCHEDULE_EXACT_ALARM`）
- Android 13+ 需要通知权限——首次进 App 会引导，被拒了也能从设置页再要一次
- 国行 ROM 建议把 App 加进电池优化白名单，否则部分机型会在深度休眠后延迟

## 已知限制

- `targetSdkVersion` 是 28，刻意压低的：精确闹钟在更高 targetSdk 上限制更多
- 大文档只取前 20000 字送去识别
- 识别质量取决于所用模型；视觉模型对糊截图会漏行，所以才有「草稿核对」这一步

## License

MIT，见 [LICENSE](LICENSE)。
