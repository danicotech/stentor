// 綁定指引。
//
// **沒有綁定碼。** 一度規劃的「網頁產生一次性碼 → `/bind <碼>`」是多餘的:
// Discord OAuth 登入本身就是綁定 —— 使用者用 Discord 登入網頁時,hestia 拿到的
// 就是他的 Discord user id,`identities` 那一列當場建好。再要一組碼來證明
// 「Discord 上那個人就是網頁上這個人」,是重新證明 OAuth 已經證明過的事。
//
// 而且碼的方案會壞:OAuth 的 state 綁在 HttpOnly cookie 上(防 login CSRF),
// 若由 stentor 代呼叫 StartDiscordLogin,那個 state 沒有任何瀏覽器持有對應的
// cookie,使用者點開連結後回呼一定失敗。
//
// 所以 `/bind` 只做一件事:給一個連結,讓使用者在**自己的瀏覽器**裡走完
// 完整的 OAuth 流程。

import { create } from '@bufbuild/protobuf';

import { ActionStyle, ViewSchema } from '../gen/hestia/render/v1/render_pb.ts';
import type { View } from '../gen/hestia/render/v1/render_pb.ts';

/** 網頁登入頁的路徑。base URL 是設定,路徑是站台結構的一部分。 */
const LOGIN_PATH = '/login';

export function loginUrl(webBaseUrl: string): string {
  return new URL(LOGIN_PATH, webBaseUrl).toString();
}

/**
 * 同一份文案有兩個入口:
 *   1. 使用者主動打 `/bind`
 *   2. 任何指令因為「這個 Discord 帳號還沒綁」而失敗時
 *
 * 兩邊共用是刻意的 —— 使用者在這兩種情境要做的事完全一樣,
 * 寫成兩份文案只會有一天不一致。
 */
export function bindGuidanceView(webBaseUrl: string, reason?: string): View {
  return create(ViewSchema, {
    title: reason ? '這個 Discord 帳號還沒有綁定' : '怎麼綁定帳號',
    description:
      '用**你自己的瀏覽器**開下面的連結,選 Discord 登入就完成綁定了 —— ' +
      '不需要輸入任何代碼。\n' +
      '登入完成後回來再輸入一次指令即可。',
    fields: [
      {
        k: '為什麼要在瀏覽器裡開',
        v: '登入流程會在你的瀏覽器留一份防偽憑證。由 Bot 代開的連結沒有那份憑證,一定會失敗。',
        inline: false,
      },
    ],
    actions: [
      {
        id: '',
        label: '前往登入頁',
        style: ActionStyle.LINK,
        url: loginUrl(webBaseUrl),
      },
    ],
    ...(reason ? { footer: reason } : {}),
    ephemeral: true,
  });
}
