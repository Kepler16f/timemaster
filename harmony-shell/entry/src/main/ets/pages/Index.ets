import { webview } from '@kit.ArkWeb';
import { HarmonyNative } from '../bridge/HarmonyNative';

@Entry
@Component
struct Index {
  controller: webview.WebviewController = new webview.WebviewController();

  build() {
    Column() {
      Web({ src: $rawfile('www/index.html'), controller: this.controller })
        .width('100%')
        .height('100%')
        .domStorageAccess(true)
        .javaScriptAccess(true)
        .fileAccess(false)
        .zoomAccess(false)
        .onControllerAttached(() => {
          HarmonyNative.i().bindWeb(this.controller);
          this.controller.registerJavaScriptProxy(
            HarmonyNative.i(), '__HarmonyNative',
            ['httpRequest', 'calEnsure', 'calFetch', 'calWrite', 'calOpen'], null);
        })
    }
    .width('100%')
    .height('100%')
  }
}
