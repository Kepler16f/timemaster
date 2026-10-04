import { AbilityConstant, UIAbility, Want } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { notificationManager } from '@kit.NotificationKit';
import { HarmonyNative } from '../bridge/HarmonyNative';

export default class EntryAbility extends UIAbility {
  private win: window.Window | null = null;

  onCreate(want: Want, launchParam: AbilityConstant.LaunchParam): void {}

  onWindowStageCreate(windowStage: window.WindowStage): void {
    HarmonyNative.i().bindCtx(this.context);
    windowStage.loadContent('pages/Index');
    this.enableImmersive(windowStage);
    this.askNotification();
  }

  /* 首次使用问一次通知开关（拒绝也不影响主流程，只是收不到变更提醒） */
  private askNotification(): void {
    try {
      notificationManager.requestEnableNotification(this.context).catch(() => {});
    } catch (e) {
    }
  }

  /* 沉浸式：窗口铺满状态栏与导航条，避让区高度经 AppStorage 交给页面转成 CSS 变量 */
  private enableImmersive(windowStage: window.WindowStage): void {
    windowStage.getMainWindow().then((win: window.Window) => {
      this.win = win;
      this.publishInsets(win);
      win.setWindowLayoutFullScreen(true).then(() => { this.publishInsets(win); }).catch(() => {});
      win.on('avoidAreaChange', (info: window.AvoidAreaOptions) => { this.publishInsets(win); });
    }).catch(() => {});
  }

  private publishInsets(win: window.Window): void {
    try {
      const top = win.getWindowAvoidArea(window.AvoidAreaType.TYPE_SYSTEM).topRect.height;
      const bottom = win.getWindowAvoidArea(window.AvoidAreaType.TYPE_NAVIGATION_INDICATOR).bottomRect.height;
      AppStorage.setOrCreate('saTopPx', top);
      AppStorage.setOrCreate('saBottomPx', bottom);
    } catch (e) {
    }
  }

  onWindowStageDestroy(): void {
    try {
      if (this.win !== null) this.win.off('avoidAreaChange');
    } catch (e) {
    }
    this.win = null;
  }

  onForeground(): void {}

  onBackground(): void {}
}
