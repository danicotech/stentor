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
      name: 'profile',
      description: '看你的等級、點數、寵物與徽章',
    },
    {
      // 賠率寫在說明裡不是客套:玩家看得到取捨,才不是被藏起來的抽成。
      name: 'game',
      description: '小遊戲。四款的期望值都低於 1,玩越多越虧',
      options: [
        {
          name: 'kind',
          description: '玩哪一款',
          type: ApplicationCommandOptionType.String,
          required: true,
          choices: [
            { name: '猜拳(贏 1.9 倍,平手退回)', value: 'rps' },
            { name: '比大小(贏 1.95 倍)', value: 'dice' },
            { name: '猜數字 1-100(中 50 倍)', value: 'guess' },
            { name: '輪盤(顏色 1.95 倍 / 數字 35 倍)', value: 'roulette' },
          ],
        },
        {
          name: 'choice',
          description: 'rock/paper/scissors、big/small、1-100、red/black 或 0-36',
          type: ApplicationCommandOptionType.String,
          required: true,
        },
        {
          name: 'stake',
          description: '押多少點',
          type: ApplicationCommandOptionType.Integer,
          required: true,
          min_value: 1,
        },
      ],
    },
    {
      name: 'box',
      description: '開箱',
      options: [
        {
          name: 'list',
          description: '看有哪些箱子',
          type: ApplicationCommandOptionType.Subcommand,
        },
        {
          name: 'open',
          description: '開一個箱子',
          type: ApplicationCommandOptionType.Subcommand,
          options: [
            {
              name: 'id',
              description: '箱子的 id(用 /box list 查)',
              type: ApplicationCommandOptionType.String,
              required: true,
            },
          ],
        },
      ],
    },
    {
      name: 'giveaway',
      description: '抽獎活動',
      options: [
        {
          name: 'list',
          description: '看進行中的抽獎',
          type: ApplicationCommandOptionType.Subcommand,
        },
        {
          name: 'join',
          description: '報名參加',
          type: ApplicationCommandOptionType.Subcommand,
          options: [
            {
              name: 'id',
              description: '抽獎的 id(用 /giveaway list 查)',
              type: ApplicationCommandOptionType.String,
              required: true,
            },
          ],
        },
      ],
    },
    {
      name: 'pet',
      description: '寵物',
      options: [
        {
          name: 'list',
          description: '看你的寵物',
          type: ApplicationCommandOptionType.Subcommand,
        },
        {
          name: 'deploy',
          description: '換出戰寵物(出戰中的才會跟著你一起漲 XP)',
          type: ApplicationCommandOptionType.Subcommand,
          options: [
            {
              name: 'id',
              description: '寵物的 id(用 /pet list 查)',
              type: ApplicationCommandOptionType.String,
              required: true,
            },
          ],
        },
        {
          name: 'rename',
          description: '幫寵物取名字',
          type: ApplicationCommandOptionType.Subcommand,
          options: [
            {
              name: 'id',
              description: '寵物的 id',
              type: ApplicationCommandOptionType.String,
              required: true,
            },
            {
              name: 'nickname',
              description: '新名字(留空 = 還原成原本的名稱)',
              type: ApplicationCommandOptionType.String,
              required: false,
              max_length: 24,
            },
          ],
        },
      ],
    },
    {
      name: 'leaderboard',
      description: '本社群的經驗值排行榜',
      options: [
        {
          name: 'count',
          description: '要看前幾名(預設 10)',
          type: ApplicationCommandOptionType.Integer,
          required: false,
          min_value: 1,
          max_value: 25,
        },
      ],
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
