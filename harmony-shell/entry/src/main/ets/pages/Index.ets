import { webview } from '@kit.ArkWeb';
import { HarmonyNative } from '../bridge/HarmonyNative';

@Entry
@Component
struct Index {
  controller: webview.WebviewController = new webview.WebviewController();
  @State diag: string = '';
  private proxyOk: boolean = false;
  private reloadTries: number = 0;

  private attachBridge(): void {
    try {
      HarmonyNative.i().bindWeb(this.controller);
      this.controller.registerJavaScriptProxy(
        HarmonyNative.i(), '__HarmonyNative',
        ['httpRequest', 'calEnsure', 'calFetch', 'calWrite', 'calOpen'], []);
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
      if (v === 'ok') {
        if (this.diag !== '') { this.diag = ''; }
        return;
      }
      if (this.reloadTries < 2) {
        this.reloadTries += 1;
        this.diag = '桥未注入，正在重载重试（' + this.reloadTries + '/2）…';
        this.attachBridge();
        try { this.controller.refresh(); } catch (e) { this.diag = '重载失败：' + e.message; }
        return;
      }
      this.diag = '桥未注入 window（' + v + '），网盘同步与系统日历不可用';
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
        .onControllerAttached(() => { this.attachBridge(); })
        .onPageEnd(() => { this.selfCheck(); })
        .onErrorReceive((event) => {
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
