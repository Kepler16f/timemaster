# 用户约定

- 每次构建前，先向用户确认本次版本号，收到回复后才能构建。
- 不自行推测、沿用或提升版本号。版本号确认前可以修改代码、运行静态检查和单元测试。
- 推送 main、推送版本标签或手动触发平台工作流可能自动构建，也必须先确认版本号。
- 确认后使用 public/app.js 的 APP_VERSION 作为版本名称来源，运行 npm run version:sync；发布时同步递增 Android 与 HarmonyOS 的 versionCode。
