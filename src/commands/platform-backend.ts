// 平台自己的指令。
//
// 它實作的是與活動服務**完全相同**的介面(RenderBackend),所以 dispatcher
// 對它沒有任何特殊待遇。這不是潔癖:一旦平台走特殊路徑,活動就會開始
// 抄那條特殊路徑,分層就化掉了。
//
// 這裡也沒有任何業務計算。簽到給多少、餘額是多少、買不買得起,
// 全部是 hestia 回來的數字,stentor 只負責把它們排成一則訊息。

import { create } from '@bufbuild/protobuf';
import type { MessageInitShape } from '@bufbuild/protobuf';
import { Code, ConnectError } from '@connectrpc/connect';

import { FieldSchema, RenderResultSchema, ViewSchema } from '../gen/hestia/render/v1/render_pb.ts';
import type { RenderResult, View } from '../gen/hestia/render/v1/render_pb.ts';
import type { PrivacySettings } from '../gen/hestia/platform/v1/me_pb.ts';
import { ActionStyle } from '../gen/hestia/render/v1/render_pb.ts';
import type { RenderBackend } from '../gateway/dispatcher.ts';
import type { IncomingInteraction } from '../gateway/interaction.ts';
import { buildCustomId } from '../routing/custom-id.ts';
import type { Route } from '../routing/registry.ts';
import { actingHeaders, type PlatformClients } from '../platform/client.ts';
import { rulesNoticeView } from '../announce/rules.ts';
import { bindGuidanceView } from './bind.ts';
import { formatAmount, formatDurationDays, formatLimit } from './format.ts';

/** 平台佔用的前綴。加新前綴要同時加 handler,否則 registry 會有名無實。 */
export const PLATFORM_PREFIXES = [
  'daily',
  'balance',
  'shop',
  'bind',
  'privacy',
  'profile',
  'leaderboard',
] as const;
export type PlatformPrefix = (typeof PLATFORM_PREFIXES)[number];

function view(init: Parameters<typeof create<typeof ViewSchema>>[1]): RenderResult {
  return create(RenderResultSchema, { kind: { case: 'view', value: create(ViewSchema, init) } });
}

function wrap(v: View, updateSource = false): RenderResult {
  return create(RenderResultSchema, { kind: { case: 'view', value: v }, updateSource });
}

export interface PlatformBackendDeps {
  readonly clients: PlatformClients;
  /** 網頁前端的位址。/bind 與「還沒綁定」的指引都指向它的登入頁。 */
  readonly webBaseUrl: string;
}

export class PlatformBackend implements RenderBackend {
  readonly #clients: PlatformClients;
  readonly #webBaseUrl: string;

  constructor(deps: PlatformBackendDeps) {
    this.#clients = deps.clients;
    this.#webBaseUrl = deps.webBaseUrl;
  }

  async handleCommand(route: Route, interaction: IncomingInteraction): Promise<RenderResult> {
    const sub = interaction.commandPath.trim().split(/\s+/).slice(1).join(' ');
    try {
      switch (route.prefix as PlatformPrefix) {
        case 'daily':
          return await this.#daily(interaction);
        case 'balance':
          return await this.#balance(interaction);
        case 'shop':
          return await this.#shop(interaction);
        case 'bind':
          return this.#bind();
        case 'profile':
          return await this.#profile(interaction);
        case 'leaderboard':
          return await this.#leaderboard(interaction);
        case 'privacy':
          return await this.#privacy(interaction, sub);
        default:
          return view({ title: '沒有這個指令', ephemeral: true });
      }
    } catch (err) {
      return this.#toView(err);
    }
  }

  async handleComponent(route: Route, interaction: IncomingInteraction): Promise<RenderResult> {
    const segments = interaction.customId.split(':').slice(1);
    try {
      if (route.prefix === 'shop' && segments[0] === 'buy') {
        return await this.#buy(interaction, segments[1] ?? '');
      }
      return view({
        title: '這個按鈕已經沒有作用了',
        description: '它可能來自舊版本的訊息。請重新執行一次指令。',
        ephemeral: true,
      });
    } catch (err) {
      return this.#toView(err);
    }
  }

  // ── /daily ────────────────────────────────────────────────

  async #daily(interaction: IncomingInteraction): Promise<RenderResult> {
    const headers = actingHeaders(interaction.actor.discordUserId);
    const res = await this.#clients.daily.claim({}, { headers });
    return view({
      title: '簽到成功',
      fields: [
        { k: '本次獲得', v: formatAmount(res.amount), inline: true },
        { k: '連續天數', v: `${res.streak} 天`, inline: true },
      ],
      ephemeral: true,
    });
  }

  // ── /balance ──────────────────────────────────────────────

  async #balance(interaction: IncomingInteraction): Promise<RenderResult> {
    const headers = actingHeaders(interaction.actor.discordUserId);
    const res = await this.#clients.me.listBalances({}, { headers });
    if (res.balances.length === 0) {
      return view({ title: '餘額', description: '目前沒有任何餘額。', ephemeral: true });
    }
    return view({
      title: '餘額',
      fields: res.balances.map((b) => ({
        k: b.currency,
        v: formatAmount(b.amount),
        inline: true,
      })),
      ephemeral: true,
    });
  }

  // ── /shop ─────────────────────────────────────────────────

  async #shop(interaction: IncomingInteraction): Promise<RenderResult> {
    const headers = actingHeaders(interaction.actor.discordUserId);
    const res = await this.#clients.shop.listItems({ includeDelisted: false }, { headers });
    if (res.items.length === 0) {
      return view({ title: '商店', description: '目前沒有上架的商品。', ephemeral: true });
    }
    return view({
      title: '商店',
      description: '按下按鈕購買。扣款與履約都由平台處理。',
      fields: res.items.map((item) => ({
        k: item.name,
        v: [
          `價格 ${formatAmount(item.price)} ${item.currency}`,
          `效期 ${formatDurationDays(item.durationDays)}`,
          `限購 ${formatLimit(item.perUserLimit)}`,
          item.description,
        ]
          .filter(Boolean)
          .join('\n'),
        inline: false,
      })),
      actions: res.items.map((item) => ({
        id: buildCustomId('shop', 'buy', item.publicId),
        label: item.name,
        style: ActionStyle.PRIMARY,
      })),
      ephemeral: true,
    });
  }

  async #buy(interaction: IncomingInteraction, itemPublicId: string): Promise<RenderResult> {
    if (!itemPublicId) {
      return view({ title: '這個按鈕壞了', description: '缺少商品識別碼。', ephemeral: true });
    }
    const headers = actingHeaders(interaction.actor.discordUserId);
    // 冪等鍵用 Discord 的 interaction id:同一次點擊重送只會扣一次錢。
    // 這是 hestia 的要求(shop.proto:Purchase 必填 idempotency_key)。
    const res = await this.#clients.shop.purchase(
      { itemPublicId, idempotencyKey: `discord-interaction:${interaction.id}` },
      { headers },
    );
    return view({
      title: res.replayed ? '這筆已經買過了' : '購買成功',
      fields: [
        { k: '扣款', v: `${formatAmount(res.price)} ${res.currency}`, inline: true },
        ...(res.redemptionPublicId ? [{ k: '工單', v: res.redemptionPublicId, inline: true }] : []),
        ...(res.entitlementPublicId
          ? [{ k: '權益', v: res.entitlementPublicId, inline: true }]
          : []),
      ],
      ephemeral: true,
    });
  }

  // ── /bind ─────────────────────────────────────────────────

  // 不打任何 API:綁定發生在使用者自己的瀏覽器裡(見 commands/bind.ts)。
  #bind(): RenderResult {
    return wrap(bindGuidanceView(this.#webBaseUrl));
  }

  // ── /profile ──────────────────────────────────────────────

  async #profile(interaction: IncomingInteraction): Promise<RenderResult> {
    const headers = actingHeaders(interaction.actor.discordUserId);
    const res = await this.#clients.me.getSummary({}, { headers });

    const fields: MessageInitShape<typeof FieldSchema>[] = [];

    // 等級放最前面:那是這個指令存在的主要理由。
    for (const x of res.xp) {
      fields.push({
        k: `${x.communityName} 等級`,
        v: `**Lv.${x.level}**  ${progressBar(x.xpIntoLevel, x.xpForLevel)}
${formatAmount(x.xp)} XP`,
        inline: false,
      });
    }
    for (const b of res.balances) {
      fields.push({ k: b.currency, v: formatAmount(b.amount), inline: true });
    }
    if (res.pet) {
      fields.push({
        k: '出戰寵物',
        v: `${res.pet.name}(Lv.${res.pet.level})`,
        inline: true,
      });
    }
    if (res.badges.length > 0) {
      fields.push({
        k: `徽章 ×${res.badges.length}`,
        v: res.badges.map((b) => b.name).join('、'),
        inline: false,
      });
    }

    // 一個什麼都還沒有的新人,看到空白的檔案會以為指令壞了。
    // 明確告訴他下一步做什麼,比什麼都不說好。
    if (fields.length === 0) {
      fields.push({ k: '還沒有紀錄', v: '打一次 `/daily` 就會開始累積。', inline: false });
    }

    return view({
      title: `${res.profile?.displayName ?? '你'} 的檔案`,
      fields,
      ephemeral: true,
    });
  }

  // ── /leaderboard ──────────────────────────────────────────

  async #leaderboard(interaction: IncomingInteraction): Promise<RenderResult> {
    const headers = actingHeaders(interaction.actor.discordUserId);
    const raw = interaction.options['count'];
    const count = raw === undefined ? 0 : Number.parseInt(raw, 10);
    const res = await this.#clients.me.getLeaderboard(
      {
        // 社群由後端從呼叫者的所在推定;M1 只有一個社群,先留空。
        communityPublicId: '',
        limit: Number.isFinite(count) ? count : 0,
      },
      { headers },
    );

    if (res.entries.length === 0) {
      return view({
        title: '排行榜',
        description: '還沒有人累積經驗值。打一次 `/daily` 就是第一名。',
        ephemeral: true,
      });
    }
    return view({
      title: '經驗值排行榜',
      description: res.entries
        .map(
          (e) => `${medal(e.rank)} **${e.displayName}** — Lv.${e.level}(${formatAmount(e.xp)} XP)`,
        )
        .join('\n'),
      ephemeral: true,
    });
  }

  // ── /privacy ──────────────────────────────────────────────

  async #privacy(interaction: IncomingInteraction, sub: string): Promise<RenderResult> {
    const userId = interaction.actor.discordUserId;
    switch (sub) {
      case 'notice':
        // 純文案,不打任何 API。管理員可以把這則貼在規則頻道。
        return wrap(rulesNoticeView({ ephemeral: true }));
      case 'status': {
        const res = await this.#clients.me.getPrivacy({}, { headers: actingHeaders(userId) });
        return view({
          title: '你的隱私設定',
          fields: privacyFields(res.settings),
          ephemeral: true,
        });
      }
      case 'optout': {
        const level = interaction.options['level'] ?? 'logging';
        if (level !== 'none' && level !== 'logging' && level !== 'corpus') {
          return view({ title: '不認得的層級', description: level, ephemeral: true });
        }
        const res = await this.#clients.me.updatePrivacy(privacyUpdate(level), {
          headers: actingHeaders(userId),
        });
        return view({
          title: '已更新隱私設定',
          fields: privacyFields(res.settings),
          // 退出記錄 ≠ 退出計分(schemas/02)。文案寫成「完全不記錄我」是錯的,
          // 使用者會以為自己不再拿得到 XP。
          footer: '你的則數與語音時長仍然計入 XP 與點數,只是內容不再保存。',
          ephemeral: true,
        });
      }
      default:
        return view({
          title: '可用的隱私指令',
          fields: [
            { k: '/privacy notice', v: 'Bot 記錄哪些資料', inline: false },
            { k: '/privacy status', v: '看目前設定', inline: false },
            { k: '/privacy optout', v: '退出記錄或退出 AI 語料', inline: false },
          ],
          ephemeral: true,
        });
    }
  }

  // ── 錯誤 → 使用者看得懂的訊息 ─────────────────────────────

  #toView(err: unknown): RenderResult {
    if (err instanceof ConnectError) {
      // 「這個 Discord 帳號還沒綁」是唯一一種使用者自己能解決的 FailedPrecondition,
      // 所以它不走通用文案,直接給綁定指引。
      if (isActorNotLinked(err)) {
        return wrap(bindGuidanceView(this.#webBaseUrl, '你還沒有平台帳號,或還沒用 Discord 登入過'));
      }
      return wrap(connectErrorView(err));
    }
    throw err;
  }
}

/**
 * 認出「代打對象尚未綁定」。
 *
 * hestia 把它映射成 FailedPrecondition(語意是「去引導綁定」而不是「重試」),
 * 但同一個 code 也用在餘額不足、限購已滿、退款窗口已關 —— **光看 code 分不出來**,
 * 所以只能再比對訊息。
 *
 * 這是脆弱的:hestia 改一次文案這裡就失效(退化成通用的「現在還不能這樣做」,
 * 不會出錯,但使用者少了指引)。已回報請 hestia 給一個機器可讀的標記
 * (獨立的 code,或 connect error detail)。在那之前這是唯一的辦法。
 */
const NOT_LINKED_PATTERN = /尚未綁定|not linked/i;

export function isActorNotLinked(err: ConnectError): boolean {
  return err.code === Code.FailedPrecondition && NOT_LINKED_PATTERN.test(err.rawMessage);
}

// 這幾句話的精確度是有代價的:寫成「完全不記錄我」會讓使用者以為自己
// 不再拿得到 XP,而事實相反(schemas/02:退出記錄不等於退出計分)。
//
// 契約是**兩個各自獨立的旗標**,不是一個層級(me.proto 的 PrivacySettings)。
// 這裡照著顯示兩個,而不是折成一個「目前層級」——折疊的那一版看不出
// 「不留紀錄」與「不進語料」同時開著的狀態,使用者會以為自己只設了一個。
function privacyFields(
  settings: PrivacySettings | undefined,
): MessageInitShape<typeof FieldSchema>[] {
  return [
    {
      k: '訊息內容',
      v: settings?.optOutLogging ? '不保存(則數與 XP 照算)' : '正常記錄',
      inline: true,
    },
    {
      k: 'AI 語料',
      v: settings?.optOutAiCorpus ? '不納入' : '納入',
      inline: true,
    },
  ];
}

// 只送這次要改的那一個旗標,不動另一個:UpdatePrivacyRequest 的欄位是
// optional 就是為了這件事(沒帶 = 維持原值)。兩個都送等於使用者調一個
// 會意外重設另一個。
function privacyUpdate(level: 'none' | 'logging' | 'corpus'): {
  optOutLogging?: boolean;
  optOutAiCorpus?: boolean;
} {
  switch (level) {
    case 'logging':
      return { optOutLogging: true };
    case 'corpus':
      return { optOutAiCorpus: true };
    case 'none':
      // 「恢復正常記錄」是唯一該同時關掉兩個的選項:使用者選它就是要全部回到預設。
      return { optOutLogging: false, optOutAiCorpus: false };
  }
}

/**
 * Connect 的錯誤碼 → 文案。
 *
 * 這張表是「協定層」的翻譯,不是業務判斷:它只知道 AlreadyExists 代表
 * 「這件事做過了」,不知道那件事是簽到還是買東西。
 */
function connectErrorView(err: ConnectError): View {
  switch (err.code) {
    case Code.AlreadyExists:
      return create(ViewSchema, {
        title: '這件事已經做過了',
        description: '重複的操作不會再執行一次。',
        ephemeral: true,
      });
    case Code.FailedPrecondition:
      return create(ViewSchema, {
        title: '現在還不能這樣做',
        description: err.rawMessage,
        ephemeral: true,
      });
    case Code.PermissionDenied:
      return create(ViewSchema, {
        title: '你沒有權限做這件事',
        ephemeral: true,
      });
    case Code.Unauthenticated:
      // 走代打這條路,Unauthenticated 只會來自**服務 token 本身**無效,
      // 不是使用者沒綁(那是 FailedPrecondition,見 isActorNotLinked)。
      // 所以這裡不能叫使用者去登入 —— 他做什麼都沒用,這是部署的問題。
      return create(ViewSchema, {
        title: '這個 Bot 的設定有問題',
        description: '它現在沒辦法代你跟平台說話。請告訴管理員。',
        ephemeral: true,
      });
    case Code.NotFound:
      return create(ViewSchema, { title: '找不到這個東西', ephemeral: true });
    case Code.ResourceExhausted:
      return create(ViewSchema, {
        title: '太快了',
        description: '請稍後再試。',
        ephemeral: true,
      });
    default:
      return create(ViewSchema, {
        title: '出了點狀況',
        description: '這次沒有成功,請稍後再試一次。',
        ephemeral: true,
      });
  }
}

// progressBar 畫本級進度。純文字而不是圖片:Discord 的 embed 不吃內嵌圖表,
// 而且文字在手機上也讀得到。
//
// span 為 0(table 曲線走到表尾,沒有下一級)時視為滿格 —— 顯示 0/0 會讓人
// 以為壞了。
function progressBar(into: bigint, span: bigint): string {
  const width = 10;
  if (span <= 0n) return '█'.repeat(width) + ' MAX';
  const ratio = Number(into) / Number(span);
  const filled = Math.max(0, Math.min(width, Math.round(ratio * width)));
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)} ${into}/${span}`;
}

function medal(rank: number): string {
  switch (rank) {
    case 1:
      return '🥇';
    case 2:
      return '🥈';
    case 3:
      return '🥉';
    default:
      return `\`${String(rank).padStart(2, ' ')}.\``;
  }
}
