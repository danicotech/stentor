// 語音活動記錄。
//
// 為什麼是語音而不是上線狀態:`voiceStateUpdate` 不需要特權 intent、
// Bot 重啟後可以從 guild 的語音狀態補回來、隱身也遮不掉
// (stentor/CLAUDE.md 的限制表)。所以它是唯一可以拿來發點數的活動訊號。
//
// **這裡不算任何點數。** 秒數與同時在席人數是觀察到的事實,發不發、發多少
// 是 hestia 看 economy_configs 決定的(activity.proto 的 xp_awarded 就是它回的)。
//
// 唯一保存的東西是「這個人是什麼時候進來的」——那不是業務狀態,是配對用的緩衝:
// Discord 的離開事件不會告訴你他什麼時候進來的,而 hestia 的冪等鍵需要 joined_at。
// 權威仍在 hestia;Bot 重啟時緩衝會空掉,那些沒收尾的紀錄由 hestia 那側處理。

import { timestampFromDate } from '@bufbuild/protobuf/wkt';

import type { PlatformClients } from '../platform/client.ts';
import { actingHeaders } from '../platform/client.ts';
import type { Logger } from '../shared/log.ts';

export interface VoiceStateSnapshot {
  readonly userId: string;
  readonly guildId: string;
  /** null = 不在任何語音頻道。 */
  readonly channelId: string | null;
  readonly selfMuted: boolean;
  readonly selfDeafened: boolean;
  /** 該頻道當下的人數(含自己)。 */
  readonly peerCount: number;
}

export type VoiceTransition =
  | { readonly kind: 'joined'; readonly channelId: string }
  | { readonly kind: 'left'; readonly channelId: string }
  | { readonly kind: 'moved'; readonly from: string; readonly to: string }
  | { readonly kind: 'updated'; readonly channelId: string }
  | { readonly kind: 'ignored' };

/**
 * 純函式:兩個語音狀態 → 發生了什麼。
 *
 * discord.js 的 voiceStateUpdate 對「靜音」「移動」「進」「出」用的是同一個事件,
 * 差別全在 before/after 的 channelId。把這個判斷抽成純函式,是因為它是
 * 最容易寫反的一段,而寫反的後果是點數發錯。
 */
export function classifyVoiceState(
  before: VoiceStateSnapshot,
  after: VoiceStateSnapshot,
): VoiceTransition {
  if (before.channelId === null && after.channelId !== null) {
    return { kind: 'joined', channelId: after.channelId };
  }
  if (before.channelId !== null && after.channelId === null) {
    return { kind: 'left', channelId: before.channelId };
  }
  if (before.channelId !== null && after.channelId !== null) {
    if (before.channelId !== after.channelId) {
      return { kind: 'moved', from: before.channelId, to: after.channelId };
    }
    return { kind: 'updated', channelId: after.channelId };
  }
  return { kind: 'ignored' };
}

interface OpenSession {
  readonly joinedAt: Date;
  readonly peerSamples: number[];
  selfMuted: boolean;
  selfDeafened: boolean;
}

export interface VoiceRecorderOptions {
  readonly clients: PlatformClients;
  readonly log: Logger;
  /** 注入時鐘,測試才能不靠真的時間。 */
  readonly now?: () => Date;
}

export class VoiceRecorder {
  readonly #clients: PlatformClients;
  readonly #log: Logger;
  readonly #now: () => Date;
  readonly #open = new Map<string, OpenSession>();

  constructor(options: VoiceRecorderOptions) {
    this.#clients = options.clients;
    this.#log = options.log;
    this.#now = options.now ?? (() => new Date());
  }

  get openSessionCount(): number {
    return this.#open.size;
  }

  async onVoiceStateUpdate(before: VoiceStateSnapshot, after: VoiceStateSnapshot): Promise<void> {
    const transition = classifyVoiceState(before, after);
    switch (transition.kind) {
      case 'joined':
        await this.#open_(after, transition.channelId);
        return;
      case 'left':
        await this.#close(before, transition.channelId);
        return;
      case 'moved':
        await this.#close(before, transition.from);
        await this.#open_(after, transition.to);
        return;
      case 'updated':
        // 靜音狀態改變不另外送一次請求(那會變成每次靜音都打一次 API),
        // 只更新緩衝,離開時一起送。
        this.#sample(after, transition.channelId);
        return;
      default:
        return;
    }
  }

  #key(userId: string, guildId: string, channelId: string): string {
    return `${guildId}/${channelId}/${userId}`;
  }

  #sample(state: VoiceStateSnapshot, channelId: string): void {
    const session = this.#open.get(this.#key(state.userId, state.guildId, channelId));
    if (!session) return;
    session.peerSamples.push(state.peerCount);
    session.selfMuted = state.selfMuted;
    session.selfDeafened = state.selfDeafened;
  }

  async #open_(state: VoiceStateSnapshot, channelId: string): Promise<void> {
    const joinedAt = this.#now();
    this.#open.set(this.#key(state.userId, state.guildId, channelId), {
      joinedAt,
      peerSamples: [state.peerCount],
      selfMuted: state.selfMuted,
      selfDeafened: state.selfDeafened,
    });

    // 先送一筆「開著的」紀錄。這樣即使 Bot 之後掛掉,hestia 也知道有人在裡面。
    await this.#send(state, channelId, {
      joinedAt,
      leftAt: null,
      peerCountAvg: state.peerCount,
      selfMuted: state.selfMuted,
      selfDeafened: state.selfDeafened,
    });
  }

  async #close(state: VoiceStateSnapshot, channelId: string): Promise<void> {
    const key = this.#key(state.userId, state.guildId, channelId);
    const session = this.#open.get(key);
    if (!session) {
      // Bot 在這段語音中間重啟過。沒有 joined_at 就沒有冪等鍵,補送只會製造
      // 一筆對不上的紀錄,所以寧可不送並留一行 log。
      this.#log.warn('語音離開事件沒有對應的進入時間,略過', {
        discord_user_id: state.userId,
        channel_id: channelId,
      });
      return;
    }
    this.#open.delete(key);
    const leftAt = this.#now();
    session.peerSamples.push(state.peerCount);
    await this.#send(state, channelId, {
      joinedAt: session.joinedAt,
      leftAt,
      peerCountAvg: average(session.peerSamples),
      selfMuted: session.selfMuted,
      selfDeafened: session.selfDeafened,
    });
  }

  async #send(
    state: VoiceStateSnapshot,
    channelId: string,
    data: {
      joinedAt: Date;
      leftAt: Date | null;
      peerCountAvg: number;
      selfMuted: boolean;
      selfDeafened: boolean;
    },
  ): Promise<void> {
    const headers = actingHeaders(state.userId);
    const durationSeconds =
      data.leftAt === null
        ? undefined
        : Math.max(0, Math.round((data.leftAt.getTime() - data.joinedAt.getTime()) / 1000));

    try {
      const res = await this.#clients.activity.recordVoiceSession(
        {
          guildId: state.guildId,
          channelId,
          joinedAt: timestampFromDate(data.joinedAt),
          ...(data.leftAt ? { leftAt: timestampFromDate(data.leftAt) } : {}),
          ...(durationSeconds !== undefined ? { durationSeconds } : {}),
          selfMuted: data.selfMuted,
          selfDeafened: data.selfDeafened,
          peerCountAvg: data.peerCountAvg,
        },
        { headers },
      );
      this.#log.debug('語音記錄已送出', {
        discord_user_id: state.userId,
        channel_id: channelId,
        closed: res.closed,
        deduplicated: res.deduplicated,
        voice_seconds_counted: res.voiceSecondsCounted,
      });
    } catch (err) {
      // 記錄失敗不該影響任何互動。留 log,不重試——重試要有佇列,
      // 而佇列是狀態,這個 repo 不存狀態。
      this.#log.error('語音記錄送出失敗', {
        discord_user_id: state.userId,
        channel_id: channelId,
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      });
    }
  }
}

function average(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}
