// Discord 互動的抽象。
//
// 這層存在的唯一理由是**可測**:discord.js 的 Interaction 物件連著一個
// 真的 WebSocket 連線與一個真的 REST client,要在測試裡造一個出來不切實際。
// 所以 gateway 以下的所有程式碼只認識這裡的介面,adapter.ts 負責把 discord.js
// 的物件翻成它。沒有 Discord token 也能把整條路徑測完。
//
// 注意這些介面裡**沒有 discord.js 的型別**,只有 render 層的 payload。

import type { APIModalInteractionResponseCallbackData } from 'discord.js';

import type { MessagePayload } from '../render/view.ts';

export type InteractionKind = 'command' | 'component' | 'modal';

/** 「誰在哪裡按的」。與 render 契約的 Actor 一一對應。 */
export interface ActorInfo {
  readonly discordUserId: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly locale: string;
}

export interface IncomingInteraction {
  readonly kind: InteractionKind;
  /** Discord 的 interaction id。活動服務拿它當冪等鍵的素材。 */
  readonly id: string;
  /** 指令路徑,空白分隔(`daily`、`privacy optout`);非指令為空字串。 */
  readonly commandPath: string;
  /** 元件 / 表單的 custom_id;指令為空字串。 */
  readonly customId: string;
  /** 指令選項,一律以字串傳遞。 */
  readonly options: Readonly<Record<string, string>>;
  /** 下拉選單選了什麼。 */
  readonly values: readonly string[];
  /** 表單欄位的值。 */
  readonly inputs: Readonly<Record<string, string>>;
  readonly actor: ActorInfo;
}

export interface DeferOptions {
  readonly ephemeral: boolean;
  /** true = 之後要編輯觸發互動的那則訊息,而不是回一則新的。 */
  readonly update: boolean;
}

/**
 * 回覆通道。
 *
 * 拆成四個動作而不是一個 `reply(payload)`,是因為 Discord 對這四件事
 * 有不同的 HTTP 端點與不同的 3 秒規則,混在一起會在線上以「互動失敗」呈現。
 */
export interface InteractionResponder {
  /** 先卡位。Discord 要求 3 秒內有第一個回應,而呼叫後端一定不只 3 秒。 */
  defer(options: DeferOptions): Promise<void>;
  /** defer 之後送出內容。 */
  send(payload: MessagePayload): Promise<void>;
  /** defer(update) 之後就地更新原訊息。 */
  editSource(payload: MessagePayload): Promise<void>;
  /**
   * 開表單。**不能在 defer 之後呼叫** —— Discord 的 modal 必須是第一個回應。
   * dispatcher 因此不會對可能回 modal 的互動先 defer,見 dispatcher.ts 的說明。
   */
  openModal(payload: APIModalInteractionResponseCallbackData): Promise<void>;
  /** 目前是否已經 defer 過。 */
  readonly deferred: boolean;
}
