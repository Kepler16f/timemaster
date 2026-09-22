import { webview } from '@kit.ArkWeb';
import { HarmonyNative } from '../bridge/HarmonyNative';

@Entry
@Component
struct Index {
  controller: webview.WebviewController = new webview.WebviewController();
  @State diag: string = '';
  private proxyOk: boolean = false;

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

  /* 页面加载完成后自检：桥是否真的注入到了 window，网页脚本有没有跑起来 */
  private selfCheck(): void {
    if (!this.proxyOk) return;
    this.controller.runJavaScript(
      '(function(){return typeof window.__HarmonyNative + "|" + (document.getElementById("app")?document.getElementById("app").childElementCount:-1);})()'
    ).then((v: string) => {
      const parts = v.split('|');
      if (parts[0] !== 'object') { this.diag = '桥未注入 window（当前 ' + v + '）'; return; }
      if (parts[1] === '-1') { this.diag = '页面缺少 #app 容器：' + v; return; }
      if (Number(parts[1]) === 0) { this.diag = '页面已加载但脚本未渲染内容（' + v + '）'; return; }
      this.diag = '';
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
