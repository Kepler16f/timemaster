import { webview } from '@kit.ArkWeb';
import { common } from '@kit.AbilityKit';
import { HarmonyHttp } from './HarmonyHttp';
import { HarmonyCalendar } from './HarmonyCalendar';

export class HarmonyNative {
  private static readonly inst: HarmonyNative = new HarmonyNative();
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
}
