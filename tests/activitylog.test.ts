// 活動記錄的測試。
//
// 重點在「Bot 觀察到的事實有沒有正確地變成一次 API 呼叫」,
// 而不是「發了多少點數」—— 那是 hestia 的事,這裡連問都不問。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { classifyVoiceState, VoiceRecorder } from '../src/activitylog/voice.ts';
import type { VoiceStateSnapshot } from '../src/activitylog/voice.ts';
import { MessageRecorder } from '../src/activitylog/messages.ts';
import type { PlatformClients } from '../src/platform/client.ts';
import { silentLogger } from '../src/shared/log.ts';

interface Recorded {
  readonly rpc: string;
  readonly request: Record<string, unknown>;
  readonly headers: Record<string, string> | undefined;
}

function fakeActivityClients(
  recorded: Recorded[],
  responses: Record<string, unknown> = {},
): PlatformClients {
  const activity = new Proxy(
    {},
    {
      get: (_t, rpc: string) => (req: unknown, opts?: { headers?: Record<string, string> }) => {
        recorded.push({
          rpc,
          request: req as Record<string, unknown>,
          headers: opts?.headers,
        });
        return Promise.resolve(responses[rpc] ?? { results: [], succeeded: 0, failed: 0 });
      },
    },
  );
  return { activity } as unknown as PlatformClients;
}

const state = (channelId: string | null, peers = 2): VoiceStateSnapshot => ({
  userId: '100000000000000001',
  guildId: '200000000000000002',
  channelId,
  selfMuted: false,
  selfDeafened: false,
  peerCount: peers,
});

describe('語音狀態分類', () => {
  test('進入', () => {
    assert.deepEqual(classifyVoiceState(state(null), state('c1')), {
      kind: 'joined',
      channelId: 'c1',
    });
  });

  test('離開', () => {
    assert.deepEqual(classifyVoiceState(state('c1'), state(null)), {
      kind: 'left',
      channelId: 'c1',
    });
  });

  test('換頻道', () => {
    assert.deepEqual(classifyVoiceState(state('c1'), state('c2')), {
      kind: 'moved',
      from: 'c1',
      to: 'c2',
    });
  });

  test('只是靜音 → 不算進出', () => {
    assert.deepEqual(classifyVoiceState(state('c1'), state('c1')), {
      kind: 'updated',
      channelId: 'c1',
    });
  });

  test('兩邊都不在語音 → 什麼都不是', () => {
    assert.deepEqual(classifyVoiceState(state(null), state(null)), { kind: 'ignored' });
  });
});

describe('語音記錄', () => {
  function recorderAt(times: Date[]) {
    const recorded: Recorded[] = [];
    let i = 0;
    const voice = new VoiceRecorder({
      clients: fakeActivityClients(recorded, {
        recordVoiceSession: {
          deduplicated: false,
          closed: false,
          voiceSecondsCounted: 0,
          xpAwarded: 0n,
        },
      }),
      log: silentLogger,
      now: () => times[Math.min(i++, times.length - 1)] as Date,
    });
    return { voice, recorded };
  }

  test('進入時先送一筆開著的紀錄(Bot 掛掉也知道有人在裡面)', async () => {
    const t0 = new Date('2026-09-08T10:00:00Z');
    const { voice, recorded } = recorderAt([t0]);

    await voice.onVoiceStateUpdate(state(null), state('c1'));

    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]?.rpc, 'recordVoiceSession');
    assert.equal(recorded[0]?.request['leftAt'], undefined, '還沒離開就不該有 left_at');
    assert.deepEqual(recorded[0]?.headers, { 'X-Acting-User': 'discord:100000000000000001' });
    assert.equal(voice.openSessionCount, 1);
  });

  test('離開時用同一個 joined_at 收尾(那是冪等鍵的一部分)', async () => {
    const t0 = new Date('2026-09-08T10:00:00Z');
    const t1 = new Date('2026-09-08T10:30:00Z');
    const { voice, recorded } = recorderAt([t0, t1]);

    await voice.onVoiceStateUpdate(state(null), state('c1'));
    await voice.onVoiceStateUpdate(state('c1'), state(null));

    assert.equal(recorded.length, 2);
    const open = recorded[0]?.request as { joinedAt: unknown };
    const close = recorded[1]?.request as { joinedAt: unknown; durationSeconds: number };
    assert.deepEqual(close.joinedAt, open.joinedAt, 'joined_at 必須一模一樣');
    assert.equal(close.durationSeconds, 1800);
    assert.equal(voice.openSessionCount, 0);
  });

  test('換頻道 = 收掉舊的 + 開一個新的', async () => {
    const times = [
      new Date('2026-09-08T10:00:00Z'),
      new Date('2026-09-08T10:10:00Z'),
      new Date('2026-09-08T10:10:00Z'),
    ];
    const { voice, recorded } = recorderAt(times);

    await voice.onVoiceStateUpdate(state(null), state('c1'));
    await voice.onVoiceStateUpdate(state('c1'), state('c2'));

    assert.equal(recorded.length, 3);
    assert.equal(recorded[1]?.request['channelId'], 'c1');
    assert.equal(recorded[2]?.request['channelId'], 'c2');
    assert.equal(voice.openSessionCount, 1);
  });

  test('靜音狀態改變不打 API(否則每次靜音都是一次請求)', async () => {
    const { voice, recorded } = recorderAt([new Date()]);
    await voice.onVoiceStateUpdate(state(null), state('c1'));
    await voice.onVoiceStateUpdate(state('c1'), state('c1'));
    assert.equal(recorded.length, 1);
  });

  test('沒有配對到進入時間就不送(Bot 重啟過),而不是亂編一個', async () => {
    const { voice, recorded } = recorderAt([new Date()]);
    await voice.onVoiceStateUpdate(state('c1'), state(null));
    assert.equal(recorded.length, 0);
  });

  test('API 失敗不會往外丟例外(記錄失敗不該影響任何互動)', async () => {
    const clients = {
      activity: {
        recordVoiceSession: () => Promise.reject(new Error('502')),
      },
    } as unknown as PlatformClients;
    const voice = new VoiceRecorder({ clients, log: silentLogger });
    await voice.onVoiceStateUpdate(state(null), state('c1'));
  });
});

describe('訊息記錄', () => {
  const message = (id: string, author = 'u1') => ({
    guildId: 'g1',
    authorId: author,
    channelId: 'c1',
    channelKind: 'text',
    threadId: null,
    messageId: id,
    content: '哈囉',
    hasAttachment: false,
    replyTo: null,
    createdAt: new Date('2026-09-08T10:00:00Z'),
  });

  test('湊到批次大小才送,一次請求只代表一位作者', async () => {
    const recorded: Recorded[] = [];
    const recorder = new MessageRecorder({
      clients: fakeActivityClients(recorded),
      log: silentLogger,
      batchSize: 2,
      contentEnabled: true,
    });

    await recorder.record(message('m1', 'u1'));
    await recorder.record(message('m2', 'u2'));
    assert.equal(recorded.length, 0, '不同作者不會湊成一批');

    await recorder.record(message('m3', 'u1'));
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]?.headers?.['X-Acting-User'], 'discord:u1');
    assert.equal((recorded[0]?.request['messages'] as unknown[]).length, 2);
  });

  test('flush 把剩下的都送出去', async () => {
    const recorded: Recorded[] = [];
    const recorder = new MessageRecorder({
      clients: fakeActivityClients(recorded),
      log: silentLogger,
      batchSize: 100,
    });

    await recorder.record(message('m1'));
    assert.equal(recorder.pendingCount, 1);
    await recorder.flush();
    assert.equal(recorder.pendingCount, 0);
    assert.equal(recorded.length, 1);
  });

  test('沒有 MESSAGE_CONTENT intent 時仍然計數,但不送內容', async () => {
    const recorded: Recorded[] = [];
    const recorder = new MessageRecorder({
      clients: fakeActivityClients(recorded),
      log: silentLogger,
      batchSize: 1,
      contentEnabled: false,
    });

    await recorder.record(message('m1'));

    const sent = (
      recorded[0]?.request['messages'] as { content: string; contentLength: number }[]
    )[0];
    assert.equal(sent?.content, '');
    assert.equal(sent?.contentLength, 0);
    assert.equal(recorded.length, 1, '則數還是有送出去');
  });

  test('沒有內容 intent 就沒有舊內容可留,編輯/刪除直接跳過', async () => {
    const recorded: Recorded[] = [];
    const recorder = new MessageRecorder({
      clients: fakeActivityClients(recorded),
      log: silentLogger,
      contentEnabled: false,
    });

    await recorder.recordRevision({
      guildId: 'g1',
      authorId: 'u1',
      channelId: 'c1',
      messageId: 'm1',
      previousContent: '舊的',
      kind: 'edited',
      capturedAt: new Date(),
    });
    assert.equal(recorded.length, 0);
  });

  test('表情回應不受內容 intent 限制,而且不送 channel_id', async () => {
    const recorded: Recorded[] = [];
    const recorder = new MessageRecorder({
      clients: fakeActivityClients(recorded, { recordReaction: {} }),
      log: silentLogger,
      contentEnabled: false,
    });

    await recorder.recordReaction({
      guildId: 'g1',
      messageId: 'm1',
      reactorId: 'u2',
      emoji: '👍',
      action: 'added',
      occurredAt: new Date(),
      messageAuthorId: 'u1',
    });

    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]?.headers?.['X-Acting-User'], 'discord:u2', '主體是按的人');
    assert.equal('channelId' in (recorded[0]?.request ?? {}), false);
  });

  test('批次送出失敗不會往外丟(不能影響 Discord 事件迴圈)', async () => {
    const clients = {
      activity: { recordMessages: () => Promise.reject(new Error('boom')) },
    } as unknown as PlatformClients;
    const recorder = new MessageRecorder({ clients, log: silentLogger, batchSize: 1 });
    await recorder.record(message('m1'));
    assert.equal(recorder.pendingCount, 0, '失敗的批次不會卡在緩衝裡越積越多');
  });
});
