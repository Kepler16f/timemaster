# Reunion · 多人共享日程

> 一个给家人和朋友共用的日程 App：建一个「空间」，把 8 位邀请码发给对方，彼此的日程、上班/休息标记就出现在同一张日历上。
> **没有自建服务器，没有账号体系，没有月费** —— 数据就是一个 JSON 文件，放在你自己的坚果云（WebDAV）里。

- 平台：Android 5.1+（minSdk 22，APK）与 HarmonyOS NEXT（API 12，HAP）
- 版本：见 `public/app.js` 的 `APP_VERSION`；已发布的包在 [Releases](../../releases)
- 包名：`com.timemaster.app`（历史原因保留，请勿修改，否则老设备无法覆盖安装）

---

## 一、它解决什么问题

日历类 App 的共享通常绑定在某家厂商的账号体系上（Google Calendar、华为日历、苹果日历），跨品牌、跨账号就用不了。Reunion 走另一条路：

| 常见方案 | 问题 | Reunion 的做法 |
| --- | --- | --- |
| 共享日历账户 | 双方必须是同一家厂商用户 | 只依赖 WebDAV，坚果云/移动云盘/Nextcloud 都行 |
| 自建服务器 | 要买服务器、要维护、要公网地址 | 零服务器，网盘文件即数据库 |
| 单一时间轴 | 看不出「谁的日程排到几点」 | 按成员分色 + 每人一条时间跨度轨 |

## 二、架构

一套 H5 代码承担全部业务逻辑，两端各套一层原生壳，只为了两件事：**发网络请求**和**读写系统日历**。

```
public/  一套 H5（视图、CRDT 合并、WebDAV 客户端、ICS 解析）
  ├── 壳 A：Capacitor 6 (Android)      → NativeHttp(OkHttp) + AndroidCalendar(CalendarContract)
  └── 壳 B：ArkWeb (HarmonyOS NEXT)    → HarmonyHttp(@ohos.net.http) + HarmonyCalendar(Calendar Kit)
```

为什么网络必须走原生桥：坚果云 WebDAV 不返回 CORS 头，WebView 里的 `fetch` 直接被拦。`transport.js` 统一封装，浏览器里的 `fetch` 只作为本地开发的降级路径。

## 三、目录

```
public/                 前端全部代码（两端壳共用）
  index.html style.css   视图与样式
  app.js                 视图引擎（月/周/日三视图）、日程增删改、空间与设置
  store.js               v2 数据模型 + 确定性合并引擎 + ETag 同步状态机 + 离线队列
  dav.js                 WebDAV 客户端（发现、读写、清空）
  ics.js                 .ics 解析与 RRULE 渲染期展开
  transport.js           原生网络桥统一入口（Capacitor / __HarmonyNative / fetch）
  calbridge.js           系统日历读写桥
  auth.js                可选的邮箱验证码登录（Supabase GoTrue REST，零 SDK）
  update.js              应用内更新（仅 Android：检查 → 原生后台下载 → 唤起安装）
android-shell/          Capacitor Android 工程 + 两个自定义插件
harmony-shell/          DevEco 工程（ArkWeb + ArkTS 桥），CI 用命令行 hvigor 构建
scripts/                sync-harmony-web.mjs（把 public/ 拷进 HAP 的 rawfile）
tests/                  纯 Node 单元测试（核心逻辑 + 鸿蒙桥模拟）
server.js               历史遗留的零依赖 Node 后端，当前不参与发版
.github/workflows/      android.yml / harmony.yml
ROADMAP.md              设计与取舍的详细记录
```

## 四、数据方案

网盘路径：`/shared-calendar/{邀请码}.json`

```jsonc
{
  "v": 2, "id": "...", "name": "空间名",
  "members": { "<clientId>": { "name": "小明", "color": "#e5484d", "joinedAt": 1690000000000 } },
  "events":  { "<eventId>": { "id": "...", "ownerId": "...", "title": "...", "date": "2026-09-22",
                              "endDate": "", "allDay": false, "start": "09:30", "end": "10:30",
                              "type": "work|rest|", "desc": "", "location": "",
                              "rrule": { "freq": "WEEKLY", "byDay": ["MO","WE"] },
                              "sourceUid": "", "updatedAt": 1690000000000, "by": "<clientId>" } },
  "deletions": { "<eventId>": 1690000000000 }   // 墓碑
}
```

**只存原始事件 + RRULE，循环日程在渲染期按月展开。** 这是刻意的设计：如果把循环日程展开成几百条实例写进网盘，文件体积和网盘流量都会失控。目标是每人每月 < 50MB，坚果云免费额度（每月 1GB 上传）绰绰有余。

合并算法（不依赖服务器，任意顺序同步都收敛到同一结果）：

1. `members` 按 `clientId` 取并集，`joinedAt` 旧者胜；
2. `events` 按 `id` 取并集，同 id 冲突取 `updatedAt` 大者，相等则 `clientId` 字典序大者胜（LWW）；
3. 墓碑时间戳晚于事件 `updatedAt` → 删除胜出。

同步状态机：写操作 → 标脏 → 防抖 3s → `GET`(If-None-Match) → 合并 → `PUT`(If-Match) → 412 则重拉重试 ≤3 次 → 失败进离线队列。前台每 60s 轮询一次 `GET` 头，304 时零流量。

## 五、功能

- **空间**：创建 / 邀请码加入 / 改名（仅创建者）/ 切换 / 快速切换列表 / 冷启动回到上次进入的空间
- **视图**：月（色块 + 当日日程卡列表 + 每人时间跨度轨）、周（7 列时间轴、重叠自动分栏）、日（单列时间轴 + 当前时间红线）；假勤标记（班/休）
- **日程**：全天/定时、跨天、地点、备注、重复（每天/周/月/年，含 BYDAY、INTERVAL、UNTIL）、按成员色筛选、批量删除
- **导入导出**：.ics 导入；与系统日历双向（Android CalendarContract / 鸿蒙 Calendar Kit），系统日程按 `sourceUid` 去重
- **成员**：昵称、标签色、设备身份（原生侧持久化，清缓存不换人）
- **其他**：深色模式（浅色/深色/跟随系统）、Android 应用内更新、横屏适配

## 六、构建与发布

**本地不做构建，APK 与 HAP 全部由 GitHub Actions 产出。**

| 流水线 | 触发 | 产出 |
| --- | --- | --- |
| `android.yml` | push main / tag `v*` | `app-debug.apk`（artifact）+ Release 上的 `reunion-vX.Y.Z.apk`；tag 触发额外签名 release 包 |
| `harmony.yml` | push main（`harmony-shell/**`、`public/**` 有改动） | `timemaster.hap`（artifact）+ Release 上的 `reunion-vX.Y.Z.hap` |

要点：

- HAP 由 `ErBWs/setup-ohos` 拉取公开 SDK 镜像（带 sha256 校验）后用命令行 hvigor 构建，**不需要 DevEco Studio、不需要登录华为账号**。
- CI 产出的 HAP **未签名**。签名与安装由使用者在本地完成（`ohos-sign` 或 DevEco），仓库里不放任何证书。
- artifact 一律以原始文件形式上传（`archive: false`），不套 zip。
- Release 说明由 `scripts/release-notes.sh` 依据上一个 `v*` 标签到当前提交的记录自动生成，两条流水线共用。
- 版本号只在 `public/app.js` 的 `APP_VERSION` 一处定义，CI 从这里解析出 tag 与产物文件名；改版本时同步 `android-shell/app/build.gradle` 的 `versionName/versionCode` 与 `harmony-shell` 的 `versionName`。

## 七、本地开发

```bash
npm ci
node tests/core.test.js            # 核心逻辑
node tests/harmony-bridge.test.js  # 鸿蒙桥（模拟）

# 在浏览器里看 UI（原生桥不可用，同步与系统日历会降级报错，属正常）
cd public && python -m http.server 8777 --bind 127.0.0.1

# 改了 public/ 之后，把网页资源同步进两端壳（CI 也会做，但本地跑一次能提前发现路径问题）
npx cap sync android
node scripts/sync-harmony-web.mjs
```

## 八、已知限制

- 鸿蒙端不支持应用内自装 HAP，设置页的更新入口在鸿蒙上不显示，需要到 Releases 手动签名安装。
- 网盘同步是「整文件覆盖 + ETag 乐观锁」，空间成员很多（>20 人）或日程上万条时会有明显冲突重试。
- 循环日程的 RRULE 只支持 FREQ/INTERVAL/BYDAY/BYMONTHDAY/UNTIL/COUNT，`COUNT` 的精确截断在展开时被忽略（以 UNTIL 与 400 次上限兜底）。
- 邮箱登录是可选功能，未配置 Supabase 时完全不影响使用。
- 浏览器不是产品形态：没有原生桥就没有网络与系统日历能力，仅用于调 UI。
