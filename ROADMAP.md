# Shared Calendar 移动化路线图（CI 构建版 · 10 天）

> 目标：Android APK + HarmonyOS NEXT HAP 双端可用的共享日程 App。
> 不做浏览器形态，不做本地构建 —— APK/HAP 均由 GitHub Actions 产出，两平台并行推进。
> Flutter 重写暂缓（M4 后视体验需求二期启动）。

## 一、总体架构

```
┌─ 一套 H5 代码（public/，业务逻辑全部前移到前端）
│
├─ 壳A：Capacitor (Android)   → NativeHttp 桥(OkHttp) + AndroidCalendar 桥(CalendarContract)  → APK
└─ 壳B：ArkWeb  (HarmonyOS NEXT) → NativeHttp 桥(@ohos.net.http) + OhosCalendar 桥(Calendar Kit) → HAP

数据：坚果云 WebDAV 上的 space 文件（免服务器、免组网）
本地：localStorage 缓存 + 合并引擎 + 离线队列
server.js：保留不集成（历史遗留，二期可作"自建模式"适配器）
```

关键约束：
- 所有网络请求经壳内原生桥发出（绕开 WebView CORS；坚果云 WebDAV 无 CORS 头）
- 只存"原始事件 + RRULE"，渲染时按可见月份本地展开 —— 控制文件体积 = 控制网盘流量（目标 <50MB/月/人，免费额度绰绰有余）
- 删除采用墓碑（tombstone），配合整文件覆盖式网盘同步

## 二、数据方案

网盘路径：`/shared-calendar/{邀请码}.json`（邀请码 8 位 hex）

```js
{
  v: 2, id, name,
  members: { [clientId]: { name, color, joinedAt } },
  events:  { [eventId]: { id, ownerId, title, date, allDay, start, end,
                          type, desc, location, rrule, sourceUid, updatedAt } },
  deletions: { [eventId]: timestamp }   // 墓碑
}
```

合并算法（确定性收敛）：
1. members 按 clientId 并集，joinedAt 旧者胜
2. events 按 id 并集；同 id 冲突取 updatedAt 大者，相等取 clientId 字典序大者
3. 墓碑时间戳晚于事件 updatedAt → 删除胜出

同步状态机：写操作 → 标脏 → 防抖 3s → GET(If-None-Match) → 合并 → PUT(If-Match) → 412 重拉重试 ≤3 次；失败进离线队列。前台 60s 轮询 GET 头（304 零流量）。

## 三、桥接协议（两端共用，一次定义）

`public/transport.js`：
```js
NativeHttp.request({ method, url, headers, body })
  → Promise<{ status, headers, bodyBase64 | text }>
```

`public/calbridge.js`：
```js
NativeCalendar.fetchEvents(fromDate, toDate) → Promise<Event[]>   // 含 sourceUid/lastModified
NativeCalendar.writeBack(events)             → Promise<void>       // 只写独立账户「共享日程」
NativeCalendar.available()                   → Promise<bool>
```

## 四、仓库与 CI 结构

```
shared-calendar/
├─ public/               # H5 主体（唯一业务代码源）
│  ├─ ics.js store.js dav.js transport.js calbridge.js
│  └─ index.html app.js style.css ...
├─ android-shell/        # Capacitor 工程（含 Kotlin 插件 NativeHttp / AndroidCalendar）
├─ harmony-shell/        # DevEco 工程（ArkWeb + ets 插件 NativeHttp / OhosCalendar）
├─ .github/workflows/
│  ├─ android.yml        # APK 构建（成熟路线）
│  └─ harmony.yml        # HAP 构建（best effort，见风险）
└─ ROADMAP.md
```

### android.yml（APK，稳定可控）
- `setup-java`(17) + `setup-node`(20) → `npm ci` → `npx cap sync android` → `gradlew assembleDebug`
- debug APK 直接 `upload-artifact`（任何人可装）
- release：keystore 经 Actions Secrets 注入（`KEYSTORE_B64`/密码），产出签名 APK；打 tag 触发

### harmony.yml（HAP，风险项，失败降级见第六节）
- HarmonyOS 无官方 Linux CI SDK。路线：社区方案（Docker 镜像/Actions 装 Command Line Tools + hvigor + ohpm）尝试 `hvigorw assembleHap`
- 调试签名材料（.p12/.cer/.p7b profile）由 DevEco 本机一次性生成后以 Secrets 注入 CI；或产物为未签名 HAP、由 `hap-sign-tool` 步骤在 CI 内签名
- 验收标准：Actions 产出可侧载安装的 HAP artifact

## 五、双线并行计划（2026-09-22 起，≤10 天）

| 天 | 主线（共享） | 线A · Android | 线B · 鸿蒙 |
|---|---|---|---|
| D1 | 建 GitHub 仓库并推送；CI 骨架跑通（apk artifact 先出空壳）；Capacitor 工程初始化 | `NativeHttp` 桥（OkHttp），模拟器请求通坚果云 PROPFIND | 确认 DevEco 环境；调研 HAP CI 可行镜像，跑 hello-world 构建 |
| D2-D3 | ICS 解析前移为 `ics.js`（存规则不炸开）；`store.js` 合并引擎/离线队列；`dav.js` 同步状态机；网盘设置页 | 用壳 A 调试；双身份（两台设备模拟）对同一 space 离线各改 5 处→合并验收 | 壳 B：ArkWeb 加载 rawfile 前端 + `domStorageAccess`/混合内容配置 + `NativeHttp`（@ohos.net.http） |
| D4-D5 | 同步 UI（状态角标/手动同步） | `AndroidCalendar`（CalendarContract 查询 + 独立账户回写 + 权限流）；**APK 首次装机验收** | 壳 B 完成 D1-D3 功能回归（鸿蒙 WebView 兼容性问题集中在此暴露） |
| D6-D8 | 双端同空间协作联调准备 | CI release 签名配置 | `OhosCalendar`（Calendar Kit 读写）；harmony.yml 调通；**HAP 真机首次验收** |
| D9-D10 | Android + 鸿蒙各一台真机 + 网盘三端联调；一周试用启动 | 正式签名 APK | 签名 HAP 侧载；图标/包名/版本收尾 |

## 六、风险与降级

| 风险 | 概率 | 降级方案 |
|---|---|---|
| HAP CI 构建调不通（无官方 Linux SDK） | 中高 | 降级为"本地 DevEco 构建 HAP"（仅这一环节破例），APK 仍全程 CI；harmony.yml 保留编译检查用途 |
| Calendar Kit 回写踩坑（账户归属/刷新时机） | 中 | 先交付"读取导入"，回写挪二期，不占主线工期 |
| 坚果云 WebDAV 对 If-Match 支持有出入 | 低 | 退化为"拉取-合并-校验-覆盖"乐观重试 |
| ArkWeb 对现有 CSS/JS 兼容问题 | 低 | 问题集中在 D4-D5，预留回归日 |

## 七、明确不做（本期）

- 浏览器直接访问版（含 CORS 兼容、本地代理）
- server.js 自建模式接入
- 网盘数据加密、OneDrive/百度/阿里适配器
- Flutter 重写、M4 级打磨（提醒通知、周/日视图、小组件）→ 二期

## 八、开工前置（D0，不占工期）

- [ ] 坚果云账号 + 生成应用密码
- [ ] GitHub 账号与 `gh` CLI 登录（建仓、推代码、配 Secrets）
- [ ] Android Studio + JDK17、Node ≥20（本机 Node 24 已满足）
- [ ] DevEco Studio 5.0+ 挂后台下载安装；NEXT 真机或模拟器
- [ ] 准备一台测试用安卓真机/模拟器 + 一台鸿蒙 NEXT 真机（联调验收用）
