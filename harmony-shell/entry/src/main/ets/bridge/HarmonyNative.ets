import { webview } from '@kit.ArkWeb';
import { common } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { preferences } from '@kit.ArkData';
import { HarmonyHttp } from './HarmonyHttp';
import { HarmonyCalendar } from './HarmonyCalendar';

export class HarmonyNative {
  private static readonly inst: HarmonyNative = new HarmonyNative();
  private static devId: string = '';
  private ctrl: webview.WebviewController | null = null;
  private ctx: common.UIAbilityContext | null = null;

  static i(): HarmonyNative {
    return HarmonyNative.inst;
  }

  bindWeb(c: webview.WebviewController): void {
    this.ctrl = c;
  }

  bindCtx(c: common.UIAbilityContext): void {
    this.ctx = c;
  }

  private reply(id: string, err: string | null, resJson: string | null): void {
    if (this.ctrl === null) {
      return;
    }
    const js: string = 'window.__harmonyNativeCb && window.__harmonyNativeCb(' +
      JSON.stringify(id) + ', ' +
      (err === null ? 'null' : JSON.stringify(err)) + ', ' +
      (resJson === null ? 'null' : JSON.stringify(resJson)) + ');';
    this.ctrl.runJavaScript(js).catch(() => {});
  }

  httpRequest(id: string, optsJson: string): void {
    HarmonyHttp.request(optsJson)
      .then((r: string) => this.reply(id, null, r))
      .catch((e: Error) => this.reply(id, e.message, null));
  }

  calEnsure(id: string): void {
    HarmonyCalendar.ensure(this.ctx)
      .then(() => this.reply(id, null, '{}'))
      .catch((e: Error) => this.reply(id, e.message, null));
  }

  calFetch(id: string, fromMs: string, toMs: string): void {
    HarmonyCalendar.fetch(this.ctx, Number(fromMs), Number(toMs))
      .then((r: string) => this.reply(id, null, r))
      .catch((e: Error) => this.reply(id, e.message, null));
  }

  calWrite(id: string, payloadJson: string): void {
    HarmonyCalendar.writeBack(this.ctx, payloadJson)
      .then((r: string) => this.reply(id, null, r))
      .catch((e: Error) => this.reply(id, e.message, null));
  }

  calOpen(id: string): void {
    HarmonyCalendar.openSettings(this.ctx)
      .then(() => this.reply(id, null, '{}'))
      .catch((e: Error) => this.reply(id, e.message, null));
  }

  /* 沉浸式下状态栏图标颜色（dark=1 时用浅色图标），网页主题切换时调用 */
  uiStatusBar(id: string, dark: string): void {
    const ctx = this.ctx;
    if (ctx === null) {
      this.reply(id, '上下文未就绪', null);
      return;
    }
    const color: string = dark === '1' ? '#FFFFFF' : '#1A1A1A';
    /* 顺手把深色状态广播给页面，Web 组件底色跟着换（Index.ets 用 @StorageProp 读） */
    AppStorage.setOrCreate('uiDark', dark === '1');
    window.getLastWindow(ctx).then((win: window.Window) => {
      const props: window.SystemBarProperties = { statusBarContentColor: color };
      return win.setWindowSystemBarProperties(props);
    }).then(() => this.reply(id, null, '{}'))
      .catch((e: Error) => this.reply(id, e.message, null));
  }

  /* 设备标识存在原生偏好里：网页 localStorage 被清也不会换人 */
  deviceId(id: string): void {
    const ctx = this.ctx;
    if (ctx === null) {
      this.reply(id, '上下文未就绪', null);
      return;
    }
    HarmonyNative.readDeviceId(ctx)
      .then((v: string) => this.reply(id, null, '{"id":' + JSON.stringify(v) + '}'))
      .catch((e: Error) => this.reply(id, e.message, null));
  }

  private static newId(): string {
    const r1: string = Math.floor(Math.random() * 1e9).toString(36);
    const r2: string = Math.floor(Math.random() * 1e9).toString(36);
    return 'd' + Date.now().toString(36) + '-' + r1 + r2;
  }

  private static async readDeviceId(ctx: common.UIAbilityContext): Promise<string> {
    if (HarmonyNative.devId.length > 0) {
      return HarmonyNative.devId;
    }
    const store = await preferences.getPreferences(ctx, 'reunion');
    let v: string = String(await store.get('deviceId', ''));
    if (v.length === 0) {
      v = HarmonyNative.newId();
      await store.put('deviceId', v);
      await store.flush();
    }
    HarmonyNative.devId = v;
    return v;
  }
}
