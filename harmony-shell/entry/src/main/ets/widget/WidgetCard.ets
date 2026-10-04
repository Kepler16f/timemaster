/* 2x2/2x4 服务卡片：日期+空间名一行，下面最多四条「时间+标题」。
   卡片里不能跑事件逻辑，数据键与网页侧 widget.js 推送的 payload 一一对应 */
let storage = new LocalStorage();

@Entry(storage)
@Component
struct WidgetCard {
  @LocalStorageProp('date') date: string = '';
  @LocalStorageProp('space') space: string = '';
  @LocalStorageProp('items') items: Array<Record<string, string>> = [];

  build() {
    Column() {
      Row() {
        Text(this.date)
          .fontSize(12)
          .fontWeight(FontWeight.Bold)
          .fontColor('#E5484D')
        Blank()
        Text(this.space)
          .fontSize(11)
          .fontColor('#99000000')
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis })
      }
      .width('100%')
      .margin({ bottom: 5 })

      if (this.items.length === 0) {
        Text('今天没有更多日程')
          .fontSize(12)
          .fontColor('#99000000')
      }

      ForEach(this.items, (it: Record<string, string>) => {
        Row() {
          Text(it.time ?? '')
            .fontSize(11)
            .fontColor(it.color ?? '#E5484D')
            .margin({ right: 7 })
          Text(it.title ?? '')
            .fontSize(13)
            .fontColor('#EE1A1A1A')
            .maxLines(1)
            .textOverflow({ overflow: TextOverflow.Ellipsis })
        }
        .width('100%')
        .margin({ bottom: 2 })
      }, (it: Record<string, string>) => (it.time ?? '') + '|' + (it.title ?? ''))
    }
    .width('100%')
    .height('100%')
    .padding(10)
    .backgroundColor('#F0FFFFFF')
    .alignItems(HorizontalAlign.Start)
    .justifyContent(FlexAlign.Start)
  }
}
