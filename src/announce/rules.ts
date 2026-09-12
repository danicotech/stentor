// 規則頻道的資料告知公告。
//
// 文案的內容不是我編的,是照 hestia 的 activity.proto 逐條對出來的:
// 有那個 RPC 就寫進去,沒有就不寫。「我們可能會蒐集…」這種話術不寫——
// 使用者要看的是「你到底記了什麼」,寫得比實際多或比實際少都是錯的。
//
// 兩個用法:
//   1. `/privacy notice` —— 使用者自己叫出來看
//   2. 開機時貼到規則頻道(channel_key = 'rules'),用的是同一個 View

import { create } from '@bufbuild/protobuf';

import { ViewSchema } from '../gen/hestia/render/v1/render_pb.ts';
import type { View } from '../gen/hestia/render/v1/render_pb.ts';

/** 規則公告的頻道用途鍵。對應表在 hestia 的 space_channel_purposes。 */
export const RULES_CHANNEL_KEY = 'rules';

export interface RulesNoticeOptions {
  readonly ephemeral?: boolean;
}

export function rulesNoticeView(options: RulesNoticeOptions = {}): View {
  return create(ViewSchema, {
    title: 'Bot 記錄哪些資料',
    description:
      '為了發點數、算 XP 與辦活動,這個 Bot 會記錄下面這些事。' +
      '記錄的權威在伺服器端,Bot 本身不保存任何資料。',
    fields: [
      {
        k: '語音',
        v: '進出語音頻道的時間與在席時長,以及期間同時在席的平均人數。\n這是唯一會用來發點數與 XP 的活動訊號。',
        inline: false,
      },
      {
        k: '訊息',
        v:
          '每則訊息的則數與時間一律計入。\n' +
          '**訊息內容只有在管理員開啟記錄的頻道才會保存**,而且只存截斷後的片段。',
        inline: false,
      },
      {
        k: '編輯與刪除',
        v: '在有開啟內容記錄的頻道,訊息被編輯或刪除前的舊內容會保留一份。',
        inline: false,
      },
      {
        k: '表情回應',
        v: '誰對哪則訊息按了什麼表情,以及取消。用於抽獎與票選。',
        inline: false,
      },
      {
        k: '不記錄的東西',
        v: '私訊、語音內容、你的上線/離線狀態、你的時區(除非你自己在網站上設定)。',
        inline: false,
      },
      {
        k: '你可以退出',
        v:
          '`/privacy optout level:logging` —— 不再保存你的訊息內容\n' +
          '`/privacy optout level:corpus` —— 你的內容不進 AI 語料\n' +
          '`/privacy status` —— 看目前的設定\n' +
          '**退出記錄不等於退出計分**:則數與語音時長仍然照算,' +
          '你已經拿到與之後會拿到的點數與 XP 完全不受影響。',
        inline: false,
      },
    ],
    footer: '有疑問請找管理員。',
    ephemeral: options.ephemeral ?? false,
  });
}
