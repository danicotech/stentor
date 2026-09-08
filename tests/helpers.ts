// 測試用的假物件。
//
// 這個檔案存在的理由就是任務書寫的那句話:Discord 互動要能在沒有真 Discord
// 的情況下測。所以互動與回覆通道都是純資料,連 discord.js 都不用載入。

import type { APIModalInteractionResponseCallbackData } from 'discord.js';

import type {
  DeferOptions,
  IncomingInteraction,
  InteractionResponder,
} from '../src/gateway/interaction.ts';
import type { MessagePayload } from '../src/render/view.ts';

export interface ResponderCall {
  readonly op: 'defer' | 'send' | 'editSource' | 'openModal';
  readonly payload?: MessagePayload | APIModalInteractionResponseCallbackData;
  readonly options?: DeferOptions;
}

export class FakeResponder implements InteractionResponder {
  readonly calls: ResponderCall[] = [];
  deferred = false;

  defer(options: DeferOptions): Promise<void> {
    this.calls.push({ op: 'defer', options });
    this.deferred = true;
    return Promise.resolve();
  }

  send(payload: MessagePayload): Promise<void> {
    this.calls.push({ op: 'send', payload });
    return Promise.resolve();
  }

  editSource(payload: MessagePayload): Promise<void> {
    this.calls.push({ op: 'editSource', payload });
    return Promise.resolve();
  }

  openModal(payload: APIModalInteractionResponseCallbackData): Promise<void> {
    this.calls.push({ op: 'openModal', payload });
    return Promise.resolve();
  }

  get ops(): string[] {
    return this.calls.map((c) => c.op);
  }

  lastMessage(): MessagePayload {
    for (let i = this.calls.length - 1; i >= 0; i -= 1) {
      const call = this.calls[i];
      if (call && (call.op === 'send' || call.op === 'editSource')) {
        return call.payload as MessagePayload;
      }
    }
    throw new Error('沒有送出任何訊息');
  }
}

export function command(
  commandPath: string,
  options: Record<string, string> = {},
  overrides: Partial<IncomingInteraction> = {},
): IncomingInteraction {
  return {
    kind: 'command',
    id: 'interaction-1',
    commandPath,
    customId: '',
    options,
    values: [],
    inputs: {},
    actor: {
      discordUserId: '100000000000000001',
      guildId: '200000000000000002',
      channelId: '300000000000000003',
      locale: 'zh-TW',
    },
    ...overrides,
  };
}

export function component(
  customId: string,
  overrides: Partial<IncomingInteraction> = {},
): IncomingInteraction {
  return { ...command(''), kind: 'component', customId, commandPath: '', ...overrides };
}
