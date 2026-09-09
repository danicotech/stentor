// outbox 公告的取貨迴圈:PullAnnouncements → 推播 → AckAnnouncements。
//
// 為什麼不是接成 AnnouncementSource(announcements.ts 的那個介面):
// 那個介面是為**推送**型傳輸設計的,handler 只回 void,`attach` 還會把
// 例外吃掉——而拉取型傳輸的整個重點就是「哪幾則成功了」,因為只有成功的
// 才能 Ack。所以這裡直接用 dispatcher.handle(),它逐則回報結果。
//
// AnnouncementSource 沒有被取代:開機時的規則公告仍然走記憶體來源,
// 測試也用它灌假事件。兩者是不同的問題,不是同一件事的兩種做法。

import type { Client } from '@connectrpc/connect';

import type { NotificationService } from '../gen/hestia/platform/v1/notification_pb.ts';
import type { Logger } from '../shared/log.ts';
import type { AnnouncementDispatcher, DeliveryOutcome } from './announcements.ts';

export interface AnnouncementPullerOptions {
  readonly client: Client<typeof NotificationService>;
  readonly dispatcher: AnnouncementDispatcher;
  readonly log: Logger;
  /** 一批最多幾則。hestia 會夾到它自己的上限。 */
  readonly max?: number;
  /**
   * 認領後多久重新可見。要遠大於一次推播往返:設太短會在還沒貼完就重發
   * (去重擋得住,但白費一次 Discord API 呼叫),太長則讓失敗的那則卡很久。
   */
  readonly visibilitySeconds?: number;
  /** 佇列空了之後隔多久再問一次。 */
  readonly idleDelayMs?: number;
  /** Pull 本身失敗(hestia 掛了/網路斷了)後的退避。 */
  readonly errorDelayMs?: number;
}

/**
 * 哪些結果算「這則處理完了,可以 Ack」。
 *
 * 四種結果都不該重試,理由各不相同:
 *   - posted    貼出去了
 *   - duplicate 之前貼過(at-least-once 下重放是常態)
 *   - unmapped  這個部署沒有對應頻道。不 Ack 的話它會永遠重新可見,
 *               佇列從此再也清不掉,而重試一百次也不會生出那個頻道
 *   - empty     公告沒有 view,是壞資料。重試不會讓它變好;已經記成 error
 *
 * 只有**丟例外**(Discord API 失敗、網路斷)才不 Ack,交給可見性逾時重來。
 * 這正是 at-least-once 的用法。
 */
const ACKABLE: ReadonlySet<DeliveryOutcome> = new Set<DeliveryOutcome>([
  'posted',
  'duplicate',
  'unmapped',
  'empty',
]);

export class AnnouncementPuller {
  readonly #client: Client<typeof NotificationService>;
  readonly #dispatcher: AnnouncementDispatcher;
  readonly #log: Logger;
  readonly #max: number;
  readonly #visibilitySeconds: number;
  readonly #idleDelayMs: number;
  readonly #errorDelayMs: number;

  #running = false;
  #wake: (() => void) | null = null;

  constructor(options: AnnouncementPullerOptions) {
    this.#client = options.client;
    this.#dispatcher = options.dispatcher;
    this.#log = options.log.child({ component: 'announcement-puller' });
    this.#max = options.max ?? 25;
    this.#visibilitySeconds = options.visibilitySeconds ?? 60;
    this.#idleDelayMs = options.idleDelayMs ?? 3000;
    this.#errorDelayMs = options.errorDelayMs ?? 15_000;
  }

  /** 跑一輪:認領一批、逐則推播、Ack 處理完的。回傳這批認領到幾則。 */
  async tick(): Promise<number> {
    const pulled = await this.#client.pullAnnouncements({
      max: this.#max,
      visibilitySeconds: this.#visibilitySeconds,
    });
    const batch = pulled.announcements;
    if (batch.length === 0) return 0;

    const done: string[] = [];
    for (const announcement of batch) {
      try {
        const outcome = await this.#dispatcher.handle(announcement);
        if (ACKABLE.has(outcome) && announcement.eventId) done.push(announcement.eventId);
      } catch (err) {
        // 不 Ack:留著讓它逾時重來。一則貼不出去不該擋住同批的其他則。
        this.#log.error('推播失敗,保留待重送', {
          event_id: announcement.eventId,
          error: describe(err),
        });
      }
    }

    if (done.length > 0) {
      // Ack 失敗只代表「這幾則會再送一次」,不是資料錯誤 —— 去重擋得住,
      // 所以記一筆就繼續,不要把整個迴圈停掉。
      try {
        const acked = await this.#client.ackAnnouncements({ eventIds: done });
        this.#log.debug('已確認送達', { sent: done.length, acknowledged: acked.acknowledged });
      } catch (err) {
        this.#log.warn('Ack 失敗,這幾則會重送', {
          count: done.length,
          error: describe(err),
        });
      }
    }
    return batch.length;
  }

  /**
   * 持續取貨直到 stop()。
   *
   * 拿滿一批就立刻再拿一次(不等待):積壓時要能追上,而不是每 3 秒才消化
   * 25 則。只有在佇列真的空了才睡。
   */
  async run(): Promise<void> {
    if (this.#running) throw new Error('AnnouncementPuller 已經在跑了');
    this.#running = true;
    this.#log.info('公告取貨迴圈啟動', {
      max: this.#max,
      visibility_seconds: this.#visibilitySeconds,
    });

    while (this.#running) {
      let delay = this.#idleDelayMs;
      try {
        const count = await this.tick();
        if (count >= this.#max) delay = 0;
      } catch (err) {
        // Pull 本身失敗:hestia 還沒起來、重啟中、或網路斷了。
        // 退避後重試,不要用滿速重打一個已經有麻煩的服務。
        this.#log.error('取貨失敗,稍後重試', { error: describe(err) });
        delay = this.#errorDelayMs;
      }
      // 再檢查一次 #running:上面那段 await 期間可能已經收到關機訊號,
      // 不檢查的話關機要多等一個完整的閒置間隔(退避時是 15 秒)。
      if (delay > 0 && this.#running) await this.#sleep(delay);
    }
    this.#log.info('公告取貨迴圈結束');
  }

  /** 停止迴圈。正在睡的話立刻醒來,不必等完那一段。 */
  stop(): void {
    this.#running = false;
    this.#wake?.();
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const finish = (): void => {
        clearTimeout(timer);
        // 清掉才不會讓下一次 stop() 去戳一個已經結束的等待。
        this.#wake = null;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      // unref:這個計時器不該讓 process 活著,關機時等它到期是白等。
      timer.unref();
      this.#wake = finish;
    });
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
