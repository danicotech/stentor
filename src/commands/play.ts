// 小遊戲、開箱、抽獎、寵物的呈現(schemas/25)。
//
// 這裡沒有任何規則計算:賠率、期望值、誰中獎、寵物幾級,全部是 hestia
// 回來的數字。閘道只負責把它們排成一則訊息 —— 這是 stentor 的第一條規則。

import { create } from '@bufbuild/protobuf';
import type { MessageInitShape } from '@bufbuild/protobuf';

import { FieldSchema, RenderResultSchema, ViewSchema } from '../gen/hestia/render/v1/render_pb.ts';
import type { RenderResult } from '../gen/hestia/render/v1/render_pb.ts';
import type {
  Giveaway,
  LootBox,
  Pet,
  PlayGameResponse,
} from '../gen/hestia/platform/v1/play_pb.ts';
import { formatAmount } from './format.ts';

type Field = MessageInitShape<typeof FieldSchema>;

function view(init: Parameters<typeof create<typeof ViewSchema>>[1]): RenderResult {
  return create(RenderResultSchema, { kind: { case: 'view', value: create(ViewSchema, init) } });
}

/** 一局遊戲的結果卡。 */
export function gameResultView(res: PlayGameResponse): RenderResult {
  const net = res.returned - res.stake;
  // 標題直接說結果。玩家最想知道的是贏還是輸,把它藏在欄位裡很不友善。
  let title: string;
  if (net > 0n) title = `贏了 +${formatAmount(net)}`;
  else if (net === 0n) title = '平手,退回本金';
  else title = `輸了 ${formatAmount(net)}`;

  return view({
    title,
    fields: [
      { k: '你出', v: res.choice, inline: true },
      { k: '開出', v: res.result, inline: true },
      { k: '押注', v: formatAmount(res.stake), inline: true },
      { k: '回收', v: formatAmount(res.returned), inline: true },
      { k: '餘額', v: formatAmount(res.balance), inline: true },
    ],
    // 種子公開是刻意的:有人覺得被做掉時,拿得出當時的隨機依據。
    footer: `seed ${res.seed.slice(0, 12)}…`,
    ephemeral: true,
  });
}

export function boxListView(boxes: readonly LootBox[]): RenderResult {
  if (boxes.length === 0) {
    return view({ title: '開箱', description: '目前沒有可開的箱子。', ephemeral: true });
  }
  return view({
    title: '可以開的箱子',
    description: '用 `/box open id:<箱子id>` 開箱。',
    fields: boxes.map((b): Field => ({
      k: b.name,
      v: [
        `${formatAmount(b.cost)} ${b.currency}`,
        b.dailyLimit > 0 ? `每日上限 ${b.dailyLimit} 次` : null,
        `\`${b.publicId}\``,
      ]
        .filter(Boolean)
        .join(' · '),
      inline: false,
    })),
    ephemeral: true,
  });
}

export function giveawayListView(list: readonly Giveaway[]): RenderResult {
  if (list.length === 0) {
    return view({ title: '抽獎', description: '目前沒有進行中的抽獎。', ephemeral: true });
  }
  return view({
    title: '進行中的抽獎',
    description: '用 `/giveaway join id:<抽獎id>` 報名。',
    fields: list.map((g): Field => ({
      k: g.title,
      v: [
        g.entryCost > 0n ? `報名費 ${formatAmount(g.entryCost)}` : '免費參加',
        `抽 ${g.winnerCount} 位`,
        `${g.entries} 人已報名`,
        `\`${g.publicId}\``,
      ].join(' · '),
      inline: false,
    })),
    ephemeral: true,
  });
}

export function petListView(pets: readonly Pet[]): RenderResult {
  if (pets.length === 0) {
    return view({
      title: '你的寵物',
      // 空清單要說下一步,不然看起來像指令壞了。
      description: '你還沒有寵物。開箱有機會抽到。',
      ephemeral: true,
    });
  }
  return view({
    title: '你的寵物',
    description: '出戰中的寵物會跟著你一起漲 XP,同時只能有一隻。',
    fields: pets.map((p): Field => ({
      k: `${p.deployed ? '⚔️ ' : ''}${p.name}`,
      v: [`Lv.${p.level}`, p.rarity || null, `${formatAmount(p.xp)} XP`, `\`${p.publicId}\``]
        .filter(Boolean)
        .join(' · '),
      inline: false,
    })),
    ephemeral: true,
  });
}
