# PLAN · v0.6.0 功能批次（农历 / 节假日 / 提醒 / 共享工具 / 桌面托盘 / 小组件）

> 本文是本批次的开发规划与实施记录。范围 = 提醒、节假日调休、农历、共同空闲、日程 RSVP、
> 空间动态、跨空间聚合视图、桌面托盘与系统通知、小组件（Android + 鸿蒙）。
> 不在本批次：iOS 壳、全量 JSON 备份、RRULE COUNT 精确截断、大字模式。
> 原则不变：无服务器、只存原始事件、渲染期展开、所有网络走原生桥、新增字段一律增量式（老客户端可忽略）。

## 一、数据结构变化（全部增量，v: 2 不变）

```jsonc
// events[id] 新增两个可选键：
{ ..., "rem": 30,                                  // 提醒：开始前多少分钟；0=准时；缺省=不提醒
  "rsvp": { "<clientId>": { "s": "yes|no|maybe", "t": 1690000000000 } } }  // 每人一个键，各写各的
// rrule 新增一个可选键：
{ "freq": "YEARLY", "interval": 1, "lunar": true,  // 仅 YEARLY 有意义：按农历月日重复（生日场景）
  ... }
```

- `rsvp` **不走整事件 LWW**：merge 时在 LWW 选出的胜者之上，把两版的 `rsvp` 逐键并集
  （每键内 `t` 大者胜）。两人同时点「来/不来」不会互相吃掉。
- `rem` 走整事件 LWW（单写者字段，无需特殊处理）。老客户端编辑时会丢弃它，可接受。
- `lunar` 同上。老客户端把「农历生日」当普通年度日程显示，不炸数据。

## 二、新增文件

| 文件 | 职责 |
| --- | --- |
| `public/lunar.js` | 公历↔农历换算（1900–2049 压缩表）、干支生肖、农历格式化；RRULE `lunar` 展开的数据底座 |
| `public/holidays.js` | 法定节假日与调休：内置 2025/2026 官方数据（国务院公告，holiday-cn 收录），localStorage 扩展年份 + 可选在线更新 |
| `public/freetime.js` | 共同空闲计算：多成员忙碌区间取补集，纯函数可测 |
| `public/notify.js` | 变更通知桥：Android=NativeNotify 插件，鸿蒙=__HarmonyNative.notify，桌面=自定义 command；浏览器=Web Notification |
| `public/widget.js` | 小组件数据推送：把「今天剩余日程」序列化推给原生壳（Android 插件 / 鸿蒙偏好存储） |
| `tests/lunar.test.js` | 农历锚点（2020–2035 每年春节、端午中秋、闰月年份）、lunar RRULE 展开、节假日数据一致性 |
| `tests/collab.test.js` | rsvp 字段级合并、同步 diff、共同空闲计算 |

`public/` 保持无框架、无构建、全 IIFE 的既有风格；`index.html` 按现有顺序挂新脚本。

## 三、修改文件（按里程碑）

### M1 农历 + 节假日（纯前端）
- `ics.js`：`expandOccurrences` 的 YEARLY 分支支持 `r.lunar`（逐日把公历转农历比对，COUNT/UNTIL/interval 语义不变）。
- `app.js`：月视图格子日期下方渲染农历日（正月初一等节日名替换农历文本，来自 Holidays）；周/日视图表头带农历日；
  详情弹层加一行农历。自动节假日以「班/休」角标显示（虚线描边样式区分手工标记）。
- `index.html` / `style.css`：对应结构与样式。
- 设置页新增「节假日与农历」组：显示已收录年份、手动「检查节假日数据更新」
  （经 `Transport.request` 拉 holiday-cn，成功存 `tm:holidays:<year>`，失败保持内置数据，绝不报错打断）。

### M2 共享价值（纯前端）
- `store.js`：
  - `merge()` 加 rsvp 字段级合并（见第一节）；
  - 新 API `setRsvp(code, eventId, status)`；
  - `syncCode` 合并后计算「远端带来的变更」diff（他人新增/修改/删除，`by`/归属判定排除自己），fire `onDiff`；
  - 新 API `onDiff(fn)`、`diffEvents(prevEvents, nextEvents, data)`（纯函数，供测试）。
- `freetime.js`：`busyIntervals(occurrences)`、`freeSlots(days, busy, window, minDur)`。
- `app.js`：
  - 详情弹层：RSVP 三按钮（仅自己可改自己的）+ 各成员状态列表；
  - 月视图 agenda 加「⏱ 找共同空闲」入口 → 弹层（成员多选 / 未来 14 天 / 时段 08–22 / 最短 30–120 分钟）→
    点空档直接带日期时间进新建日程；
  - 日历页加「动态」入口 → 弹层显示本空间最近变更（feed 存 `tm:feed`，本机日志、上限 120 条，只增不改云端）；
  - viewSeg 加「全部」档（≥2 个空间时显示）：聚合视图，合并渲染所有本机缓存空间的日程，
    每条带空间徽章；聚合视图只读（新建/编辑引导回具体空间）。

### M3 提醒（事件模型 + 双端原生）
- 编辑日程弹窗加「提醒」下拉（不提醒 / 准时 / 提前 10/30/60/120 分钟 / 提前一天）→ `rem`。
- `ics.js`：导出写 `VALARM`（`TRIGGER:-PTnM`），导入解析 VALARM → `rem`。
- `calbridge.js`：`wire()` 透传 `rem`；写回系统日历即带系统提醒。
- `AndroidCalendarPlugin.java`：upsert 后写 `CalendarContract.Reminders`（先删后插，`rem=null` 清除）。
- `HarmonyCalendar.ets`：`buildEvent`/`editEvent` 带上 `reminderTime: [rem]`（字段不被 SDK 认时静默忽略，不碍事）。
- 变更通知：`app.js` 订阅 `Store.onDiff` —— 应用在后台（`document.hidden`）时经 `notify.js` 发系统通知
  「小明 新增了 中秋聚餐」；前台不弹（界面已见）。设置页「提醒与通知」组给总开关（默认开）。
- 明确边界（写进 README）：App 关闭后的本地提醒依赖「回写系统日历」（系统闹钟接手）；
  纯应用内后台提醒（WorkManager/长驻）留待后续版本。

### M4 桌面端（Tauri）
- `main.rs`：托盘（`tray-icon` feature）：左键/双击显示主窗口，菜单「显示主窗口 / 退出」；不劫持窗口关闭按钮。
- 通知：`tauri-plugin-notification` + 自定义 command `notify`（自定义 command 不过 ACL，capabilities 零改动）。
- `Cargo.toml`：`tauri = { features = ["tray-icon", "image-png"] }`、`tauri-plugin-notification = "2"`。
- `notify.js` 桌面分支改走 `invoke('notify')`（比 Web Notification 在 WebView2 里更可靠）。

### M5 小组件
- **Android**：`WidgetPlugin.java`（`update(payload)`：存 SharedPreferences + 通知所有 widget 重画）+
  `WidgetProvider.java`（AppWidgetProvider，RemoteViews 渲染 4 行日程）+ `res/layout/widget.xml` +
  `res/xml/widget_info.xml` + Manifest 注册 receiver。
- **鸿蒙**：`EntryFormAbility.ets`（2×2 服务卡片，onAddForm 记 formId）+ `WidgetCard.ets`（LocalStorageProp 绑定）+
  `form_config.json` + `module.json5` 注册 extensionAbility；`HarmonyNative.widgetData` 存偏好并逐 formId 刷新。
- `widget.js`：进入空间 / 每次同步回调后推送 `{date, space, items:[{time,title,color}]}`；
  浏览器环境为 no-op。

### M6 收尾
- `APP_VERSION` → 0.6.0；`android-shell/app/build.gradle` versionCode 60 / versionName 0.6.0；
  `harmony-shell/AppScope/app.json5` 同步；`scripts/sync-*.mjs` 会自动盖 Tauri 两处版本。
- `node scripts/sync-harmony-web.mjs` + `node scripts/sync-desktop-web.mjs` + `npx cap sync android`。
- CHANGELOG 新增 v0.6.0 小节；README 目录表、功能节、已知限制更新。
- `node tests/*.test.js` 全绿。

## 四、测试锚点（写进单测）

- 春节（正月初一）：2020-01-25 / 2021-02-12 / 2022-02-01 / 2023-01-22 / 2024-02-10 / 2025-01-29 /
  2026-02-17 / 2027-02-06 / 2028-01-26 / 2029-02-13 / 2030-02-03 / 2031-01-23 / 2032-02-11 /
  2033-01-31 / 2034-02-19 / 2035-02-08
- 端午 2025-05-31、2026-06-19；中秋 2025-10-06、2026-09-25
- 闰月：2023 闰二月、2025 闰六月、2028 闰五月、2031 闰三月、2033 闰十一月
- 节假日：内置数据与国务院公告逐日一致（含 2026-02-14、2026-09-20、2026-10-10 三个调休上班日）

## 五、风险与对策

| 风险 | 对策 |
| --- | --- |
| 农历压缩表个别年份出错 | 锚点测试钉死 2020–2035；表格范围声明 1900–2049，范围外不显示农历 |
| 鸿蒙 CalendarKit `reminderTime` 字段名与 SDK 版本有出入 | 走 `Record<string,Object>` 弱类型赋值，不认则静默忽略；说明写进 README 已知限制 |
| 2027 年起节假日未公布 | 数据按年存储；未收录年份只显示周六日 + 手工班/休；设置页可在线更新（holiday-cn，原生桥无 CORS） |
| 小组件原生代码本地无法编译验证 | 保守 API（RemoteViews/RemoteViews 固定行数、ArkTS 卡片按官方模板），交给 CI 编译把关 |
| 聚合视图与同步逻辑互相牵连 | 聚合视图只读本机缓存（`Store.get`），不触发同步、不改 state.code；进入空间/同步路径零改动 |
| RSVP 与「仅创建者可编辑」冲突 | rsvp 独立于编辑权：任何人都能改自己的出勤，正文仍只有创建者可改 |
