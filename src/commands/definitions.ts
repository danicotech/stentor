// 平台指令的 Discord 定義。
//
// 只有平台自己的指令寫在這裡。活動的指令由活動服務透過
// `ActivityInteractionService.DescribeCommands` 自己交出來(activity/backend.ts),
// 所以加一個活動不會動到這個檔案。
//
// 指令名稱**必須**等於註冊表裡的前綴:指令與按鈕走同一張路由表,
// 名字對不上就會出現「指令通了但按鈕沒人接」。register.ts 會檢查這件事。

import { ApplicationCommandOptionType } from 'discord.js';
import type { RESTPostAPIApplicationCommandsJSONBody } from 'discord.js';

// 選項的字面意思就是使用者對這件事的全部理解,所以不能簡化成「不要記錄我」——
// 退出記錄不等於退出計分(schemas/02),寫錯會讓人以為自己放棄了 XP。
export const PRIVACY_LEVEL_CHOICES = [
  { name: '不保存我的訊息內容(則數與 XP 照算)', value: 'logging' },
  { name: '我的內容不要進 AI 語料', value: 'corpus' },
  { name: '恢復正常記錄', value: 'none' },
] as const;

export function platformCommands(): readonly RESTPostAPIApplicationCommandsJSONBody[] {
  return [
    {
      name: 'daily',
      description: '每日簽到,領取今天的點數',
    },
    {
      name: 'balance',
      description: '查看你的點數餘額',
    },
    {
      name: 'shop',
      description: '看看商店裡有什麼',
    },
    {
      // 刻意沒有參數:綁定是「用 Discord 登入網頁」,不是輸入一組碼。
      // 這個指令只負責把人帶到登入頁。
      name: 'bind',
      description: '看怎麼把這個 Discord 帳號綁到平台帳號',
    },
    {
      name: 'privacy',
      description: '資料記錄與隱私設定',
      options: [
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'notice',
          description: '這個 Bot 記錄哪些資料',
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'status',
          description: '看你目前的隱私設定',
        },
        {
          type: ApplicationCommandOptionType.Subcommand,
          name: 'optout',
          description: '退出記錄或退出 AI 語料',
          options: [
            {
              type: ApplicationCommandOptionType.String,
              name: 'level',
              description: '要退出到什麼程度',
              required: true,
              choices: PRIVACY_LEVEL_CHOICES.map((c) => ({ name: c.name, value: c.value })),
            },
          ],
        },
      ],
    },
  ];
}
