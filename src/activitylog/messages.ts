// 訊息 / 編輯刪除 / 表情回應的記錄。
//
// hestia 的 RecordMessages 是**批次**介面,而且一次請求只代表一位作者
// (行為主體是 X-Acting-User,不在 body 裡)。所以這裡按 (guild, 作者) 分桶,
// 湊到一定量或一定時間就送一次。
//
// 訊息內容需要 MESSAGE_CONTENT 特權 intent;沒有那個 intent 時 discord.js
// 拿到的 content 是空字串。**則數不需要特權 intent**,所以關掉 intent 仍然計數,
// 只是不會有內容——這正是 CLAUDE.md 限制表寫的。
//
// 這裡不算 XP、不算則數上限、不判斷哪個頻道要不要存內容:
// 頻道白名單(space_channels.log_messages)與 opt-out 都是 hestia 那側的判斷。

import { timestampFromDate } from '@bufbuild/protobuf/wkt';

import type { MessageRecord } from '../gen/hestia/platform/v1/activity_pb.ts';
import { MessageRevisionKind, ReactionAction } from '../gen/hestia/platform/v1/activity_pb.ts';
import { actingHeaders, type PlatformClients } from '../platform/client.ts';
import type { Logger } from '../shared/log.ts';

export interface ObservedMessage {
  readonly guildId: string;
  readonly authorId: string;
  readonly channelId: string;
  readonly channelKind: string;
  readonly threadId: string | null;
  readonly messageId: string;
  readonly content: string;
  readonly hasAttachment: boolean;
  readonly replyTo: string | null;
  readonly createdAt: Date;
}

export interface MessageRecorderOptions {
  readonly clients: PlatformClients;
  readonly log: Logger;
  /** 湊到這麼多則就立刻送。 */
  readonly batchSize?: number;
  /** 有內容 intent 時才會有 content;沒有時只送長度 0。 */
  readonly contentEnabled?: boolean;
}

type Bucket = { readonly guildId: string; readonly authorId: string; records: MessageRecord[] };

export class MessageRecorder {
  readonly #clients: PlatformClients;
  readonly #log: Logger;
  readonly #batchSize: number;
  readonly #contentEnabled: boolean;
  readonly #buckets = new Map<string, Bucket>();

  constructor(options: MessageRecorderOptions) {
    this.#clients = options.clients;
    this.#log = options.log;
    this.#batchSize = options.batchSize ?? 25;
    this.#contentEnabled = options.contentEnabled ?? false;
  }

  get pendingCount(): number {
    let total = 0;
    for (const bucket of this.#buckets.values()) total += bucket.records.length;
    return total;
  }

  /** 收一則訊息。滿了就順手送出去,沒滿就等 flush()。 */
  async record(message: ObservedMessage): Promise<void> {
    const key = `${message.guildId}/${message.authorId}`;
    const bucket = this.#buckets.get(key) ?? {
      guildId: message.guildId,
      authorId: message.authorId,
      records: [],
    };
    bucket.records.push({
      $typeName: 'hestia.platform.v1.MessageRecord',
      clientRef: message.messageId,
      channelId: message.channelId,
      channelKind: message.channelKind,
      ...(message.threadId ? { threadId: message.threadId } : {}),
      messageId: message.messageId,
      content: this.#contentEnabled ? message.content : '',
      contentLength: this.#contentEnabled ? message.content.length : 0,
      hasAttachment: message.hasAttachment,
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),
      createdAt: timestampFromDate(message.createdAt),
    });
    this.#buckets.set(key, bucket);

    if (bucket.records.length >= this.#batchSize) {
      await this.#flushBucket(key);
    }
  }

  /** 把所有還沒送的訊息送出去。定時器與關機流程都呼叫它。 */
  async flush(): Promise<void> {
    for (const key of [...this.#buckets.keys()]) {
      await this.#flushBucket(key);
    }
  }

  async #flushBucket(key: string): Promise<void> {
    const bucket = this.#buckets.get(key);
    if (!bucket || bucket.records.length === 0) return;
    this.#buckets.delete(key);

    try {
      const res = await this.#clients.activity.recordMessages(
        { guildId: bucket.guildId, messages: bucket.records },
        { headers: actingHeaders(bucket.authorId) },
      );
      if (res.failed > 0) {
        // hestia 逐筆回報,單筆失敗不會拖垮整批。把失敗的原因留下來就好。
        for (const result of res.results.filter((r) => !r.ok)) {
          this.#log.warn('訊息記錄失敗', {
            message_id: result.messageId,
            error_code: result.errorCode,
            error_message: result.errorMessage,
          });
        }
      }
      this.#log.debug('訊息批次已送出', {
        guild_id: bucket.guildId,
        count: bucket.records.length,
        succeeded: res.succeeded,
        failed: res.failed,
      });
    } catch (err) {
      this.#log.error('訊息批次送出失敗', {
        guild_id: bucket.guildId,
        count: bucket.records.length,
        error: describe(err),
      });
    }
  }

  /** 編輯 / 刪除前的舊內容。沒有內容 intent 就沒有舊內容可留,直接跳過。 */
  async recordRevision(input: {
    readonly guildId: string;
    readonly authorId: string;
    readonly channelId: string;
    readonly messageId: string;
    readonly previousContent: string;
    readonly kind: 'edited' | 'deleted';
    readonly capturedAt: Date;
  }): Promise<void> {
    if (!this.#contentEnabled) return;
    try {
      await this.#clients.activity.recordMessageRevision(
        {
          guildId: input.guildId,
          channelId: input.channelId,
          messageId: input.messageId,
          previousContent: input.previousContent,
          kind: input.kind === 'edited' ? MessageRevisionKind.EDITED : MessageRevisionKind.DELETED,
          capturedAt: timestampFromDate(input.capturedAt),
        },
        { headers: actingHeaders(input.authorId) },
      );
    } catch (err) {
      this.#log.error('訊息舊版本記錄失敗', {
        message_id: input.messageId,
        error: describe(err),
      });
    }
  }

  /** 表情回應。量小、不涉內容隱私、比發言難刷,是抽獎與票選的首選訊號。 */
  async recordReaction(input: {
    readonly guildId: string;
    // 刻意沒有 channelId:hestia 的 RecordReactionRequest 沒有這個欄位
    // (reaction_events 沒有頻道欄位),送過去也沒人讀。
    readonly messageId: string;
    readonly reactorId: string;
    readonly emoji: string;
    readonly action: 'added' | 'removed';
    readonly occurredAt: Date;
    readonly messageAuthorId: string | null;
  }): Promise<void> {
    try {
      await this.#clients.activity.recordReaction(
        {
          guildId: input.guildId,
          messageId: input.messageId,
          emoji: input.emoji,
          action: input.action === 'added' ? ReactionAction.ADDED : ReactionAction.REMOVED,
          occurredAt: timestampFromDate(input.occurredAt),
          ...(input.messageAuthorId ? { messageAuthorId: input.messageAuthorId } : {}),
        },
        { headers: actingHeaders(input.reactorId) },
      );
    } catch (err) {
      this.#log.error('表情回應記錄失敗', {
        message_id: input.messageId,
        error: describe(err),
      });
    }
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
