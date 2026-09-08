// discord.js 的互動物件 → 這個 repo 的抽象。
//
// 整個 repo 只有這一支檔案認識 discord.js 的 Interaction。往下的所有東西
// (路由、渲染、後端呼叫)都只認識 interaction.ts 裡的介面,所以測試不需要
// 真的 Discord 連線,也不需要 token。
//
// 這支檔案本身沒有邏輯可測——它是翻譯,錯了會在整合時立刻看到。
// 真正要測的是它翻出來的那個介面,而那個介面是純資料。

import {
  ApplicationCommandOptionType,
  MessageFlags,
  type ChatInputCommandInteraction,
  type MessageComponentInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';
import type { APIModalInteractionResponseCallbackData, CommandInteractionOption } from 'discord.js';

import type { MessagePayload } from '../render/view.ts';
import { toDiscordMessage } from '../render/view.ts';
import type {
  ActorInfo,
  DeferOptions,
  IncomingInteraction,
  InteractionResponder,
} from './interaction.ts';

/**
 * 只取結構上需要的欄位。用 discord.js 的 Interaction 聯集型別會踩到
 * ButtonInteraction / StringSelectMenuInteraction 這些子型別彼此不相容的問題,
 * 而我們要的其實只有四個字串。
 */
interface ActorSource {
  readonly user: { readonly id: string };
  readonly guildId: string | null;
  readonly channelId: string | null;
  readonly locale?: string;
}

function actorOf(interaction: ActorSource): ActorInfo {
  return {
    discordUserId: interaction.user.id,
    guildId: interaction.guildId ?? '',
    channelId: interaction.channelId ?? '',
    locale: interaction.locale ?? '',
  };
}

/**
 * `/privacy optout` 這種子指令會被 Discord 拆成 command + subcommand group + subcommand,
 * 這裡把它壓平成一個空白分隔的路徑,讓路由只需要看第一段。
 */
function commandPathOf(interaction: ChatInputCommandInteraction): string {
  const parts = [interaction.commandName];
  const group = interaction.options.getSubcommandGroup(false);
  if (group) parts.push(group);
  const sub = interaction.options.getSubcommand(false);
  if (sub) parts.push(sub);
  return parts.join(' ');
}

/**
 * 選項一律轉成字串。
 *
 * stentor 不知道哪個選項該是什麼型別 —— 活動服務才知道。在這裡保留型別
 * 只會逼得渲染契約也要有型別系統,那就是把活動的知識搬進來了。
 */
function collectOptions(
  options: readonly CommandInteractionOption[],
  out: Record<string, string>,
): void {
  for (const option of options) {
    if (
      option.type === ApplicationCommandOptionType.Subcommand ||
      option.type === ApplicationCommandOptionType.SubcommandGroup
    ) {
      collectOptions(option.options ?? [], out);
      continue;
    }
    const value = option.value;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out[option.name] = String(value);
    }
  }
}

function optionsOf(interaction: ChatInputCommandInteraction): Record<string, string> {
  const out: Record<string, string> = {};
  collectOptions(interaction.options.data, out);
  return out;
}

export function fromCommand(interaction: ChatInputCommandInteraction): IncomingInteraction {
  return {
    kind: 'command',
    id: interaction.id,
    commandPath: commandPathOf(interaction),
    customId: '',
    options: optionsOf(interaction),
    values: [],
    inputs: {},
    actor: actorOf(interaction),
  };
}

export function fromComponent(interaction: MessageComponentInteraction): IncomingInteraction {
  const values = interaction.isStringSelectMenu() ? interaction.values : [];
  return {
    kind: 'component',
    id: interaction.id,
    commandPath: '',
    customId: interaction.customId,
    options: {},
    values,
    inputs: {},
    actor: actorOf(interaction),
  };
}

export function fromModal(interaction: ModalSubmitInteraction): IncomingInteraction {
  const inputs: Record<string, string> = {};
  for (const field of interaction.fields.fields.values()) {
    // 表單欄位有多種型別(文字、勾選…),只有帶 value 的才有東西可以送。
    if ('value' in field && typeof field.value === 'string') {
      inputs[field.customId] = field.value;
    }
  }
  return {
    kind: 'modal',
    id: interaction.id,
    commandPath: '',
    customId: interaction.customId,
    options: {},
    values: [],
    inputs,
    actor: actorOf(interaction),
  };
}

type Repliable = ChatInputCommandInteraction | MessageComponentInteraction | ModalSubmitInteraction;

/**
 * 把 discord.js 的四種回覆方式包成一個 responder。
 *
 * `deferred` 這個旗標不是裝飾:Discord 對「已 defer」與「還沒回應」用的是
 * 不同的 HTTP 端點,搞錯會回 40060(interaction already acknowledged),
 * 使用者看到的是紅色的互動失敗。
 */
export class DiscordResponder implements InteractionResponder {
  #deferred = false;

  constructor(private readonly interaction: Repliable) {}

  get deferred(): boolean {
    return this.#deferred;
  }

  async defer(options: DeferOptions): Promise<void> {
    if (this.#deferred) return;
    const target = this.interaction;
    if (options.update && 'deferUpdate' in target && typeof target.deferUpdate === 'function') {
      await target.deferUpdate();
    } else {
      await target.deferReply(options.ephemeral ? { flags: MessageFlags.Ephemeral } : {});
    }
    this.#deferred = true;
  }

  async send(payload: MessagePayload): Promise<void> {
    const body = toDiscordMessage(payload);
    if (this.#deferred) {
      // editReply 不吃 flags:ephemeral 在 defer 的時候就決定了。
      const { flags: _flags, ...rest } = body;
      await this.interaction.editReply(rest);
      return;
    }
    await this.interaction.reply(body as never);
  }

  async editSource(payload: MessagePayload): Promise<void> {
    const { flags: _flags, ...rest } = toDiscordMessage(payload);
    const target = this.interaction;
    if (this.#deferred) {
      await target.editReply(rest);
      return;
    }
    if ('update' in target && typeof target.update === 'function') {
      await target.update(rest as never);
      return;
    }
    await target.reply(rest as never);
  }

  async openModal(payload: APIModalInteractionResponseCallbackData): Promise<void> {
    if (this.#deferred) {
      throw new Error('已經 defer 過的互動不能開表單(Discord 的限制)');
    }
    const target = this.interaction as { showModal?: (data: unknown) => Promise<void> };
    if (typeof target.showModal !== 'function') {
      throw new Error('這個互動不支援表單');
    }
    await target.showModal(payload);
  }
}
