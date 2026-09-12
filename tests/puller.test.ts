// 公告取貨迴圈的測試。
//
// 這裡真正要守住的是 **Ack 的界線**:Ack 掉一則沒貼出去的公告 = 那則永遠消失,
// 而且沒有任何人會發現(佇列是空的,看起來一切正常)。反過來,漏 Ack 一則
// 已經處理完的,佇列就再也清不掉。兩種錯法都不會讓任何測試「當掉」,
// 所以必須逐種結果明寫出來。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { create } from '@bufbuild/protobuf';

import { AnnouncementSchema, ViewSchema } from '../src/gen/hestia/render/v1/render_pb.ts';
import type { Announcement } from '../src/gen/hestia/render/v1/render_pb.ts';
import { AnnouncementDispatcher, type ChannelPublisher } from '../src/consumers/announcements.ts';
import { AnnouncementPuller } from '../src/consumers/puller.ts';
import type { MessagePayload } from '../src/render/view.ts';
import { silentLogger } from '../src/shared/log.ts';

const CHANNEL_KEY = 'announcements';
const CHANNEL_ID = '111111111111111111';

class FakePublisher implements ChannelPublisher {
  readonly posts: string[] = [];
  /** 這些 channelId 的推播會失敗(模擬 Discord 403 / 網路斷)。 */
  readonly failing = new Set<string>();

  post(channelId: string, _payload: MessagePayload): Promise<void> {
    if (this.failing.has(channelId)) return Promise.reject(new Error('Discord 403'));
    this.posts.push(channelId);
    return Promise.resolve();
  }
}

// channelId 由 hestia 解好隨公告送來;空字串 = 後端沒給(該用途沒設頻道,
// 或多個空間設了同一用途而無法決定),閘道略過。
function announcement(eventId: string, channelId = CHANNEL_ID): Announcement {
  return create(AnnouncementSchema, {
    eventId,
    channelKey: CHANNEL_KEY,
    channelId,
    view: create(ViewSchema, { title: '開賽了', description: '快來看' }),
  });
}

/** 沒有 view 的公告(壞資料):dispatcher 回 'empty'。 */
function viewless(eventId: string): Announcement {
  return create(AnnouncementSchema, { eventId, channelKey: CHANNEL_KEY, channelId: CHANNEL_ID });
}

interface FakeNotificationClient {
  pullAnnouncements: (req: { max: number; visibilitySeconds: number }) => Promise<{
    announcements: Announcement[];
  }>;
  ackAnnouncements: (req: { eventIds: string[] }) => Promise<{ acknowledged: number }>;
}

interface Harness {
  puller: AnnouncementPuller;
  publisher: FakePublisher;
  acked: string[][];
  pulls: number;
}

/** batches 逐輪回傳;用完之後一律回空批。 */
function harness(
  batches: Announcement[][],
  opts: { ackFails?: boolean; pullFailsFirst?: boolean } = {},
): Harness {
  const publisher = new FakePublisher();
  const acked: string[][] = [];
  const state = { pulls: 0 };
  let pullFailed = false;

  const client: FakeNotificationClient = {
    pullAnnouncements: () => {
      if (opts.pullFailsFirst && !pullFailed) {
        pullFailed = true;
        return Promise.reject(new Error('hestia 沒回應'));
      }
      const batch = batches[state.pulls] ?? [];
      state.pulls += 1;
      return Promise.resolve({ announcements: batch });
    },
    ackAnnouncements: (req) => {
      acked.push(req.eventIds);
      if (opts.ackFails) return Promise.reject(new Error('Ack 失敗'));
      return Promise.resolve({ acknowledged: req.eventIds.length });
    },
  };

  const dispatcher = new AnnouncementDispatcher({
    publisher,
    log: silentLogger,
  });

  const puller = new AnnouncementPuller({
    client: client as never,
    dispatcher,
    log: silentLogger,
  });

  return {
    puller,
    publisher,
    acked,
    get pulls() {
      return state.pulls;
    },
  };
}

describe('公告取貨迴圈', () => {
  test('貼成功的才 Ack', async () => {
    const h = harness([[announcement('e1'), announcement('e2')]]);
    const count = await h.puller.tick();
    assert.equal(count, 2);
    assert.equal(h.publisher.posts.length, 2);
    assert.deepEqual(h.acked, [['e1', 'e2']]);
  });

  // 這是最重要的一條:貼不出去卻 Ack 掉 = 那則公告永遠消失,
  // 而且佇列看起來是乾淨的,沒有人會發現。
  test('推播失敗的那則不 Ack', async () => {
    const h = harness([[announcement('boom')]]);
    h.publisher.failing.add('111111111111111111');
    await h.puller.tick();
    assert.deepEqual(h.acked, [], '失敗的不該進 Ack 清單');
    assert.equal(h.publisher.posts.length, 0);
  });

  test('一則失敗不會擋住同批的其他則', async () => {
    const publisher = new FakePublisher();
    const acked: string[][] = [];
    let attempt = 0;
    const dispatcher = new AnnouncementDispatcher({
      publisher: {
        post: (channelId) => {
          attempt += 1;
          // 第一則失敗,第二則成功。
          if (attempt === 1) return Promise.reject(new Error('Discord 500'));
          publisher.posts.push(channelId);
          return Promise.resolve();
        },
      },
      log: silentLogger,
    });
    const puller = new AnnouncementPuller({
      client: {
        pullAnnouncements: () =>
          Promise.resolve({ announcements: [announcement('first'), announcement('second')] }),
        ackAnnouncements: (req: { eventIds: string[] }) => {
          acked.push(req.eventIds);
          return Promise.resolve({ acknowledged: req.eventIds.length });
        },
      } as never,
      dispatcher,
      log: silentLogger,
    });

    await puller.tick();
    assert.equal(publisher.posts.length, 1, '第二則仍然要被貼出去');
    assert.deepEqual(acked, [['second']]);
  });

  // 不 Ack 的話它會永遠重新可見,佇列從此清不掉——而重試一百次也不會
  // 生出那個頻道。
  test('後端沒給頻道的公告要 Ack 掉,不能讓它無限重試', async () => {
    const h = harness([[announcement('orphan', '')]]);
    await h.puller.tick();
    assert.equal(h.publisher.posts.length, 0);
    assert.deepEqual(h.acked, [['orphan']]);
  });

  test('壞掉的公告(沒有 view)也要 Ack,重試不會讓它變好', async () => {
    const h = harness([[viewless('broken')]]);
    await h.puller.tick();
    assert.deepEqual(h.acked, [['broken']]);
  });

  // at-least-once 下重放是常態,不是錯誤。
  test('重放的事件算處理完,要 Ack', async () => {
    const h = harness([[announcement('dup')], [announcement('dup')]]);
    await h.puller.tick();
    await h.puller.tick();
    assert.equal(h.publisher.posts.length, 1, '只該貼一次');
    assert.deepEqual(h.acked, [['dup'], ['dup']], '兩次都要 Ack,否則第二次會卡在佇列裡');
  });

  test('空批不呼叫 Ack', async () => {
    const h = harness([[]]);
    assert.equal(await h.puller.tick(), 0);
    assert.deepEqual(h.acked, []);
  });

  // Ack 失敗只代表這幾則會重送,去重擋得住,不該讓迴圈爆掉。
  test('Ack 失敗不會往上拋', async () => {
    const h = harness([[announcement('e1')]], { ackFails: true });
    await assert.doesNotReject(() => h.puller.tick());
    assert.equal(h.publisher.posts.length, 1);
  });

  test('Pull 失敗會往上拋給 run() 處理,tick 自己不吞', async () => {
    const h = harness([[announcement('e1')]], { pullFailsFirst: true });
    await assert.rejects(() => h.puller.tick(), /hestia 沒回應/);
  });

  test('run() 遇到 Pull 失敗不會結束迴圈', async () => {
    const h = harness([[announcement('e1')]], { pullFailsFirst: true });
    const running = h.puller.run();
    // 讓退避睡眠開始之後再停,確認 stop() 能把睡到一半的迴圈叫醒。
    await new Promise((r) => setTimeout(r, 20));
    h.puller.stop();
    await running;
    assert.equal(h.publisher.posts.length, 0, '第一輪就失敗,還沒貼到任何東西');
  });

  test('stop() 之後 run() 會結束', async () => {
    const h = harness([[]]);
    const running = h.puller.run();
    h.puller.stop();
    await running;
    assert.ok(true);
  });

  test('同一個 puller 不能跑兩次', async () => {
    const h = harness([[]]);
    const running = h.puller.run();
    await assert.rejects(() => h.puller.run(), /已經在跑/);
    h.puller.stop();
    await running;
  });
});
