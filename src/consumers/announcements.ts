// outbox 事件 → 頻道推播的消費端。
//
// 現況(2026-09-08):**hestia 還沒有把 outbox 事件送出來的傳輸方式。**
// 它的 outbox 目前是 hestia 自己 `FOR UPDATE SKIP LOCKED` 在消費的,
// 沒有對外的 stream / webhook / 佇列。
//
// 所以這裡做的是「消費端」那一半:介面定死、去重定死、渲染定死,
// 傳輸留一個 AnnouncementSource 的洞。等 hestia 決定用什麼送(gRPC server
// stream、Redis stream、或 HTTP webhook),補一個實作進來即可,
// 這支檔案不用動。測試用 MemoryAnnouncementSource 灌假事件。

import type { Announcement } from '../gen/hestia/render/v1/render_pb.ts';
import { renderView, type MessagePayload } from '../render/view.ts';
import type { Logger } from '../shared/log.ts';

export type AnnouncementHandler = (announcement: Announcement) => Promise<void>;
export type Unsubscribe = () => void;

/** 事件從哪來。hestia 決定傳輸方式之前,唯一的實作是記憶體版的假來源。 */
export interface AnnouncementSource {
  subscribe(handler: AnnouncementHandler): Unsubscribe;
}

/** 貼到頻道。實作是 discord.js,測試用假的。 */
export interface ChannelPublisher {
  post(channelId: string, payload: MessagePayload): Promise<void>;
}

export type DeliveryOutcome = 'posted' | 'duplicate' | 'unmapped' | 'empty';

export interface AnnouncementDispatcherOptions {
  readonly channels: ReadonlyMap<string, string>;
  readonly publisher: ChannelPublisher;
  readonly log: Logger;
  /** 記得幾個 event_id。太小會重貼,太大會吃記憶體;預設 5000 約 300KB。 */
  readonly dedupeSize?: number;
}

export class AnnouncementDispatcher {
  readonly #channels: ReadonlyMap<string, string>;
  readonly #publisher: ChannelPublisher;
  readonly #log: Logger;
  readonly #dedupeSize: number;
  /** Set 的迭代順序是插入順序,拿它當 FIFO 就夠了,不必為此裝一個 LRU 套件。 */
  readonly #seen = new Set<string>();

  constructor(options: AnnouncementDispatcherOptions) {
    this.#channels = options.channels;
    this.#publisher = options.publisher;
    this.#log = options.log;
    this.#dedupeSize = options.dedupeSize ?? 5000;
  }

  /**
   * outbox 是**至少一次**投遞,所以重放是正常的,不是錯誤。
   * 去重靠 event_id;記憶體的去重在重啟後會失效,重啟後可能重貼一則——
   * 這是刻意的取捨:要真正只貼一次得存狀態,而這個 repo 不存狀態。
   */
  async handle(announcement: Announcement): Promise<DeliveryOutcome> {
    const log = this.#log.child({
      event_id: announcement.eventId,
      channel_key: announcement.channelKey,
    });

    if (announcement.eventId && this.#seen.has(announcement.eventId)) {
      log.debug('事件重放,略過');
      return 'duplicate';
    }

    const channelId = this.#channels.get(announcement.channelKey);
    if (!channelId) {
      // 不是錯誤:後端可能往一個這個部署沒有對應頻道的地方發。
      log.warn('沒有對應的頻道,略過');
      return 'unmapped';
    }

    if (!announcement.view) {
      log.error('公告沒有 view,略過');
      return 'empty';
    }

    const rendered = renderView(
      // 頻道推播一律公開;view.ephemeral 在這個情境沒有意義。
      { ...announcement.view, ephemeral: false },
      announcement.content ?? '',
    );
    for (const warning of rendered.warnings) log.warn('渲染警告', { warning });

    await this.#publisher.post(channelId, rendered.payload);
    this.#remember(announcement.eventId);
    log.info('已推播');
    return 'posted';
  }

  #remember(eventId: string): void {
    if (!eventId) return;
    this.#seen.add(eventId);
    if (this.#seen.size > this.#dedupeSize) {
      const oldest = this.#seen.values().next();
      if (!oldest.done) this.#seen.delete(oldest.value);
    }
  }

  /** 接上來源。回傳退訂函式。 */
  attach(source: AnnouncementSource): Unsubscribe {
    return source.subscribe(async (announcement) => {
      try {
        await this.handle(announcement);
      } catch (err) {
        // 一則貼不出去不該讓整個消費者停掉。
        this.#log.error('推播失敗', {
          event_id: announcement.eventId,
          error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        });
      }
    });
  }
}

/**
 * 記憶體來源。兩個用途:測試,以及在 hestia 補上傳輸之前讓開機流程跑得完
 * (規則公告就是靠它貼出去的)。
 */
export class MemoryAnnouncementSource implements AnnouncementSource {
  readonly #handlers = new Set<AnnouncementHandler>();

  subscribe(handler: AnnouncementHandler): Unsubscribe {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  async emit(announcement: Announcement): Promise<void> {
    for (const handler of this.#handlers) await handler(announcement);
  }

  get subscriberCount(): number {
    return this.#handlers.size;
  }
}
