import { webview } from '@kit.ArkWeb';
import { HarmonyNative } from '../bridge/HarmonyNative';

@Entry
@Component
struct Index {
  controller: webview.WebviewController = new webview.WebviewController();
  @State diag: string = '';
  @StorageProp('saTopPx') @Watch('pushInsets') saTopPx: number = 0;
  @StorageProp('saBottomPx') @Watch('pushInsets') saBottomPx: number = 0;
  /* 网页主题切到深色时，Web 组件自身底色也要跟上，否则旋转/缩放时会露出白边 */
  @StorageProp('uiDark') uiDark: boolean = false;
  private proxyOk: boolean = false;
  private reloadTries: number = 0;
  private pageReady: boolean = false;
  /* refresh() 会让主文档出现一次被中断的加载错误，属正常现象，不报给用户 */
  private reloading: boolean = false;

  /* 状态栏/导航条避让区（物理像素）交给网页换算成 --sa-* 变量 */
  private pushInsets(): void {
    if (!this.pageReady) return;
    this.controller.runJavaScript('window.__setSafeInsets(' + this.saTopPx + ',' + this.saBottomPx + ')')
      .catch(() => {});
  }

  /* 侧滑返回 / 返回键：先问网页有没有弹窗或子页可退，只有它说「该走了」才退出应用。
     onBackPress 要同步给出结果，所以一律拦下，异步判定后再决定 terminateSelf */
  onBackPress(): boolean {
    if (!this.pageReady) return false;
    this.controller.runJavaScript('window.__tmBack ? window.__tmBack() : "exit"')
      .then((v: string) => {
        if (v.split('"').join('') === 'exit') HarmonyNative.i().exitApp();
      })
      .catch(() => { HarmonyNative.i().exitApp(); });
    return true;
  }

  private attachBridge(): void {
    try {
      HarmonyNative.i().bindWeb(this.controller);
      this.controller.registerJavaScriptProxy(
        HarmonyNative.i(), '__HarmonyNative',
        ['httpRequest', 'calEnsure', 'calFetch', 'calWrite', 'calOpen', 'uiStatusBar', 'deviceId'], []);
      this.proxyOk = true;
    } catch (e) {
      this.diag = '注入桥失败：' + e.message;
    }
  }

  /* 页面加载完成后自检：桥是否真的注入到了 window。首屏常在注册之前就开始加载，
     所以探测不到时重载一次（registerJavaScriptProxy 只对注册之后开始的加载生效） */
  private selfCheck(): void {
    if (!this.proxyOk) return;
    this.controller.runJavaScript(
      '(function(){var o=window.__HarmonyNative;return (o&&typeof o.httpRequest==="function")?"ok":"missing:"+(typeof o);})()'
    ).then((v: string) => {
      /* runJavaScript 返回的是带引号的 JSON 字符串（"ok"），先去掉引号再比较 */
      const s: string = v.split('"').join('');
      if (s === 'ok') {
        if (this.diag !== '') { this.diag = ''; }
        return;
      }
      if (this.reloadTries < 2) {
        this.reloadTries += 1;
        this.pageReady = false;
        this.reloading = true;
        this.diag = '桥未注入，正在重载重试（' + this.reloadTries + '/2）…';
        this.attachBridge();
        try { this.controller.refresh(); } catch (e) { this.diag = '重载失败：' + e.message; }
        return;
      }
      this.diag = '桥未注入 window（' + s + '），网盘同步与系统日历不可用';
    }).catch((e: Error) => { this.diag = '自检失败：' + e.message; });
  }

  build() {
    Column() {
      Web({ src: $rawfile('www/index.html'), controller: this.controller })
        .width('100%')
        .height('100%')
        .domStorageAccess(true)
        .javaScriptAccess(true)
        .fileAccess(true)
        .zoomAccess(false)
        /* 默认 Off：网页里的 prefers-color-scheme 永远报浅色，「跟随系统」就形同虚设。
           Auto 让内核按系统深色模式给网页喂 prefers-color-scheme */
        .darkMode(WebDarkMode.Auto)
        .backgroundColor(this.uiDark ? '#111318' : '#F5F6F8')
        .onControllerAttached(() => { this.attachBridge(); })
        .onPageEnd(() => { this.reloading = false; this.pageReady = true; this.pushInsets(); this.selfCheck(); })
        .onErrorReceive((event) => {
          if (this.reloading) return;
          if (event !== undefined && event.request.isMainFrame()) {
            this.diag = '页面加载失败 ' + event.error.getErrorCode() + '：' + event.error.getErrorInfo();
          }
        })
        .onRenderExited((event) => {
          this.diag = event === undefined ? '渲染进程退出' : ('渲染进程退出，原因码 ' + Number(event.renderExitReason));
        })
      if (this.diag !== '') {
        Text(this.diag)
          .fontSize(13)
          .fontColor('#FFFFFF')
          .backgroundColor('#C0392B')
          .width('100%')
          .padding(12)
      }
    }
    .width('100%')
    .height('100%')
  }
}
