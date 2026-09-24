# Reunion · 多人共享日程

> 一个给家人和朋友共用的日程 App：建一个「空间」，把 8 位邀请码发给对方，彼此的日程、上班/休息标记就出现在同一张日历上。
> **没有自建服务器，没有账号体系，没有月费** —— 数据就是一个 JSON 文件，放在你自己的坚果云（WebDAV）里。

- 平台：Android 5.1+（minSdk 22，APK）与 HarmonyOS NEXT（API 12，HAP）
- 版本：见 `public/app.js` 的 `APP_VERSION`；已发布的包在 [Releases](../../releases)
- 包名：Android `com.timemaster.app`（历史原因保留，请勿修改，否则老设备无法覆盖安装）；HarmonyOS `top.timemaster.app`（自 v0.2.6 起，改名的代价见 CHANGELOG）

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

网盘路径：`/shared-calendar/{邀请码}.json`。**空间存在哪个网盘账号上是按空间记的**（本机 `tm:davBySpace`）：设置页里的表单是「本机默认账号」，新建的空间落在它上面；家人发来的配置码只把那个空间绑到发码方的账号，不会顶掉本机默认账号 —— 否则一粘配置码自己的空间立刻读不到，还会在别人的网盘里另建一份同名文档，两个人各写各的。云端文档里不落任何凭据。

```jsonc
{
  "v": 2, "id": "...", "name": "空间名", "createdBy": "<创建者身份键>",
  "members": { "<clientId>": { "name": "小明", "color": "#e5484d", "joinedAt": 1690000000000,
                               "dev": "<设备号>", "acct": "me@example.com", "davId": "a1f2c3d4",
                               "adm": 0, "admOff": 0, "admOffBy": "",
                               "out": 0, "outBy": "" } },  // dev/acct 认出同一个人；davId 认出同一个网盘账号；adm/admOff 是创建者给/收的管理员资格；out 是退出/被移出的时间戳
  "events":  { "<eventId>": { "id": "...", "ownerId": "...", "title": "...", "date": "2026-09-22",
                              "endDate": "", "allDay": false, "start": "09:30", "end": "10:30",
                              "type": "work|rest|", "desc": "", "location": "",
                              "rrule": { "freq": "WEEKLY", "byDay": ["MO","WE"] },
                              "sourceUid": "", "updatedAt": 1690000000000, "by": "<clientId>" } },
  "deletions": { "<eventId>": 1690000000000 },   // 墓碑
  "retired": { "<旧身份键>": "<接手的新身份键>" } // 成员退休留痕，见下
}
```

**只存原始事件 + RRULE，循环日程在渲染期按月展开。** 这是刻意的设计：如果把循环日程展开成几百条实例写进网盘，文件体积和网盘流量都会失控。目标是每人每月 < 50MB，坚果云免费额度（每月 1GB 上传）绰绰有余。

合并算法（不依赖服务器，任意顺序同步都收敛到同一结果）：

1. `members` 按 `clientId` 取并集，`joinedAt` 旧者胜；
2. `events` 按 `id` 取并集，同 id 冲突取 `updatedAt` 大者，相等则 `clientId` 字典序大者胜（LWW）；
3. 墓碑时间戳晚于事件 `updatedAt` → 删除胜出。

同步状态机：写操作 → 标脏 → 防抖 3s → `GET`(If-None-Match) → 合并 → `PUT`(If-Match) → 412 则重拉重试 ≤3 次 → 失败进离线队列。前台每 60s 轮询一次 `GET` 头，304 时零流量。读到 404 时只有本机确实有待写入内容才回写，且一定带 `If-None-Match: *`（仅新建）——文件真在的话会 412 挡回来，不会在错的网盘里凭空造一份。

身份键（成员表的键）会随登录状态变化：未登录是设备号，登录后是 `u:<uid>`。同一个人换过键就会显示成两个成员、旧键名下的日程还删不掉，所以：

- 合并/判定归属时先顺着 `retired` 走到接手的新键（`Store.resolve`）；
- 「同人」的证据分级：两边都有 `acct` 时邮箱说了算（同桌昵称一样也不算同一人）→ 否则 `dev` 相同且同昵称（共用平板的两人设备号相同，靠昵称分开）→ 再否则老数据的同昵称 + 同颜色（宁可放宽给本人，也不让日程变成删不掉的「别人的」）；
- 折掉/迁走的旧键一律写 `retired` 留痕，别人本机的成员留档（`seeds`）就不会把它复活成第二个人；
- 换设备登录同一邮箱时，扫一遍本机已知网盘账号的同步目录，凡成员表里有这个身份的文档就补回空间列表并绑定对应账号（`Store.followAccount`）；昵称与账户已有的不一致时弹窗问用户要哪一个，再统一写回所有空间。

角色与去留（没有服务器，所以「权限」只是本机的判断，管的是责任不是闸门）：

- 成员记录里的 `davId` 是**这个成员用的网盘账号**（`baseUrl|user` 的 FNV-1a 哈希，不写账号原文）。创建者、以及与创建者同 `davId` 的人（拿配置码进来的家人）算**管理员**，可以改名、可以移出普通成员；创建者本人动不得，同为管理员的也动不得（同一个网盘账号本来就是一家人）。老空间的创建者记录还没有 `davId`，等他在自己那台设备上同步一次就补上了。
- 同 `davId` 这条路认不出来时（换过设备、清过数据、各家算出的哈希对不齐）由创建者**手动指定**：`members[id].adm = <时间戳>` 写进云端文档，任何设备上都一样算管理员。**资格以创建者为准**：创建者能撤销任何人的管理员（含自动认定的那位），撤销时写 `admOff` + `admOffBy`，此后 `davId` 相同不再自动恢复、重粘配置码（`Store.claimAdmin`）也恢复不了，只有创建者重新指定才算数。管理员（非创建者）只能移普通成员，给不了也收不回资格。
- **被移出的人下次进入空间先看到一条告知**：`Store.kickedOut(code)`（成员记录上 `out` 是别人标的）为真时，`enterSpace` 先进「您已被移出」的单按钮弹层，确认后自动退出该空间并清掉本机副本，首页与设置-空间管理的列表同时少一条。网盘上别人那份数据不动；本机还有未同步出去的改动会在文案里明确警告。要回来请对方重发邀请码。
- **退出 / 被移出都只打标记**：`members[id].out = <时间戳>` 加 `outBy`（自己标的显示「已退出」，别人标的显示「已被移出」并弹一次通知）。名片和名下日程全部保留，不做静默删除——网盘没有事务，删掉的东西别人本机一份留档就能把它带回来，不如如实标出来。重新输邀请码进来会把 `out` 清掉，人和日程原样回归。
- 「已退出 / 已被移出」在别人眼里提几次，看 **TA 的日程还在不在空间里**：还留着的一直正常显示在名单里、绝不弹提示（日历上那些色块总得说清是谁写的，之后 TA 那边再怎么动也不打扰这个空间的人）；已经清空的是第一次画一行「已退出/已被移出」、第二次只弹一句「某某 已退出，日程已清空」、第三次起连这句也没有。已读次数记在本机 `tm:outSeen`（键 `空间|成员`，值是打开过几次），云端那条成员记录始终不动。
- 退出与移出都能勾「同时删除 TA 在该空间创建的日程」：给名下事件写墓碑，别的成员同步后一起看不到了。两件事共用同一个确认弹层（标题与勾选文案跟着身份变），本机副本一定等云端写成功之后再清，离线时会明确报错，不会出现「本机已经没了、云端还不知道」。
- 管理员移出成员要说清诚实的边界：网盘上没有服务器，被移出的人再输一次邀请码仍然能回来。

## 五、功能

- **空间**：创建 / 邀请码加入 / 改名（创建者与管理员）/ 切换 / 快速切换列表 / 冷启动回到上次进入的空间 / 扫描网盘找回「成员表里有我」的空间（换设备、清过数据后用）/ 成员自行退出（弹窗确认，可选连自己名下的日程一起清掉）
- **视图**：月（色块 + 当日日程卡列表 + 每人时间跨度轨）、周（7 列时间轴、重叠自动分栏）、日（单列时间轴 + 当前时间红线）；假勤标记（班/休）。月历格子里 **一个色块 = 一个人**（同一人当天几条只占一块，多条时块上拖一层影子），**块下的「N条」= 当天日程总条数**，**「+N」= 还有 N 个人没画下**（最多画 4 块）
- **日程**：全天/定时、跨天、地点、备注、重复（每天/周/月/年，含 BYDAY、INTERVAL、UNTIL）、按成员色筛选、批量删除
- **导入导出**：.ics 导入；与系统日历双向（Android CalendarContract / 鸿蒙 Calendar Kit），系统日程按 `sourceUid` 去重
- **成员**：昵称、标签色、设备身份（原生侧持久化，清缓存不换人）、可选邮箱账户（同一邮箱的多台设备并成一个用户，昵称冲突时问一句用哪个）；成员面板按 创建者 → 管理员 → 成员 → 已退出 排序，显示各自名下的日程条数与加入日期；创建者可以给收管理员资格、能把管理员和普通成员都移出空间，管理员（非创建者）只能移出普通成员、创建者还能把某人指定为管理员。首页「切换空间」与设置-空间管理两边都有「成员」入口（看名单不算管理权限，只读也照样给看）
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
