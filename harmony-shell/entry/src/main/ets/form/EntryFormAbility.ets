import { FormExtensionAbility, formBindingData, formProvider } from '@kit.FormKit';
import { Want, common } from '@kit.AbilityKit';
import { preferences } from '@kit.ArkData';

const FORM_KEY = 'formIds';
const FORM_ID_KEY = 'ohos.extra.param.key_form_identity';

/* 2x2 服务卡片：数据全部来自网页侧经 __HarmonyNative.widgetData 推送的快照，
   原生不做业务计算。onAddForm 记下 formId，widgetData 才知道要刷新谁 */
export default class EntryFormAbility extends FormExtensionAbility {

  onAddForm(want: Want): formBindingData.FormBindingData {
    const fid: string = EntryFormAbility.formIdOf(want);
    if (fid.length > 0) {
      EntryFormAbility.rememberForm(this.context, fid);
    }
    return formBindingData.createFormBindingData({ 'date': '', 'space': '', 'items': [] });
  }

  /* 定时刷新（form_config 里 updateDuration=1）：把最后一次推送的快照重画一遍，
     卡片才不会永远停在昨天 */
  onUpdateForm(formId: string): void {
    EntryFormAbility.refreshForm(this.context, formId);
  }

  /* 基类签名是 formId（不是 want）：签名对不上整个类过不了 ArkTS 编译 */
  onRemoveForm(formId: string): void {
    if (formId.length > 0) {
      EntryFormAbility.forgetForm(this.context, formId);
    }
  }

  onCastToNormal(formId: string): void {
  }

  onChangeFormProperties(formId: string, want: Want, isAddUpdate: boolean): void {
  }

  private static formIdOf(want: Want): string {
    const p = want.parameters;
    if (p === undefined || p === null) {
      return '';
    }
    const v = p[FORM_ID_KEY];
    return v === undefined || v === null ? '' : String(v);
  }

  private static async refreshForm(ctx: common.Context, formId: string): Promise<void> {
    try {
      const store = await preferences.getPreferences(ctx, 'reunion_widget');
      const payload = String(await store.get('payload', '{}'));
      const data: Record<string, Object> = JSON.parse(payload) as Record<string, Object>;
      await formProvider.updateForm(formId, formBindingData.createFormBindingData(data));
    } catch (e) {
    }
  }

  private static rememberForm(ctx: common.Context, fid: string): void {
    preferences.getPreferences(ctx, 'reunion_widget').then((store: preferences.Preferences) => {
      store.get(FORM_KEY, '').then((v: preferences.ValueType) => {
        const list: string[] = String(v).length > 0 ? String(v).split(',') : [];
        if (list.indexOf(fid) < 0) {
          list.push(fid);
          store.put(FORM_KEY, list.join(',')).then(() => store.flush()).catch(() => {});
        }
      }).catch(() => {});
    }).catch(() => {});
  }

  private static forgetForm(ctx: common.Context, fid: string): void {
    preferences.getPreferences(ctx, 'reunion_widget').then((store: preferences.Preferences) => {
      store.get(FORM_KEY, '').then((v: preferences.ValueType) => {
        const list: string[] = String(v).length > 0
          ? String(v).split(',').filter((s: string) => s !== fid) : [];
        store.put(FORM_KEY, list.join(',')).then(() => store.flush()).catch(() => {});
      }).catch(() => {});
    }).catch(() => {});
  }
}
