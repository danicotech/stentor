// 出事時給使用者看的東西。
//
// 這些文案刻意什麼都不解釋:「後端 500」「連線逾時」對使用者沒有意義,
// 而且會洩漏內部結構。細節進 log,使用者只需要知道「這次沒成功,可以再試」。

import { create } from '@bufbuild/protobuf';

import { ViewSchema } from '../gen/hestia/render/v1/render_pb.ts';
import type { View } from '../gen/hestia/render/v1/render_pb.ts';

/** 一般錯誤。 */
export function errorView(): View {
  return create(ViewSchema, {
    title: '出了點狀況',
    description: '這次沒有成功,請稍後再試一次。如果一直失敗,請告訴管理員。',
    ephemeral: true,
  });
}

/** 路由不到:按到了已經下架的活動按鈕,或指令沒對應的服務。 */
export function notFoundView(detail: string): View {
  return create(ViewSchema, {
    title: '這個按鈕已經沒有作用了',
    description: '對應的活動可能已經結束,或是這則訊息太舊了。',
    footer: detail,
    ephemeral: true,
  });
}

/** 後端太慢、已經 defer,結果它想開表單——Discord 不允許先 defer 再開表單。 */
export function timeoutModalView(): View {
  return create(ViewSchema, {
    title: '請再按一次',
    description: '剛剛系統反應得有點慢,表單來不及開。再按一次通常就好了。',
    ephemeral: true,
  });
}

/** hestia 還沒提供這個能力(見 platform/ports.ts)。 */
export function unavailableView(capability: string, neededRpc: string): View {
  return create(ViewSchema, {
    title: '這個功能還沒開放',
    description: '平台端還在實作中,請稍後再試。',
    fields: [
      { k: '功能', v: capability, inline: true },
      { k: '待補的 API', v: neededRpc, inline: true },
    ],
    ephemeral: true,
  });
}
