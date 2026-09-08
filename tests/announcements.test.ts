// outbox 事件 → 頻道推播的測試。
//
// hestia 還沒有把事件送出來的傳輸方式,所以這裡測的是消費端那一半:
// 頻道對應、去重、渲染、以及「一則失敗不會讓消費者停掉」。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { create } from '@bufbuild/protobuf';

import { AnnouncementSchema, ViewSchema } from '../src/gen/hestia/render/v1/render_pb.ts';
import {
  AnnouncementDispatcher,
  MemoryAnnouncementSource,
  type ChannelPublisher,
} from '../src/consumers/announcements.ts';
import type { MessagePayload } from '../src/render/view.ts';
import { rulesAnnouncement, RULES_CHANNEL_KEY } from '../src/announce/rules.ts';
import { silentLogger } from '../src/shared/log.ts';

class FakePublisher implements ChannelPublisher {
  readonly posts: { channelId: string; payload: MessagePayload }[] = [];
  failNext = false;

  post(channelId: string, payload: MessagePayload): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new Error('Discord 403'));
    }
    this.posts.push({ channelId, payload });
    return Promise.resolve();
  }
}

const channels = new Map([
  ['announcements', '111111111111111111'],
  [RULES_CHANNEL_KEY, '222222222222222222'],
]);

function announcement(eventId: string, channelKey = 'announcements') {
  return create(AnnouncementSchema, {
    eventId,
    channelKey,
    view: create(ViewSchema, { title: '開賽了', description: '快來看' }),
  });
}

describe('公告推播', () => {
  test('邏輯頻道名對到 channel id,渲染成 embed', async () => {
    const publisher = new FakePublisher();
    const dispatcher = new AnnouncementDispatcher({ channels, publisher, log: silentLogger });

    assert.equal(await dispatcher.handle(announcement('evt-1')), 'posted');
    assert.equal(publisher.posts[0]?.channelId, '111111111111111111');
    assert.equal((publisher.posts[0]?.payload.embeds[0] as { title: string }).title, '開賽了');
  });

  test('至少一次投遞:同一個 event_id 只會貼一次', async () => {
    const publisher = new FakePublisher();
    const dispatcher = new AnnouncementDispatcher({ channels, publisher, log: silentLogger });

    assert.equal(await dispatcher.handle(announcement('evt-1')), 'posted');
    assert.equal(await dispatcher.handle(announcement('evt-1')), 'duplicate');
    assert.equal(publisher.posts.length, 1);
  });

  test('沒對應的頻道就略過,不是錯誤', async () => {
    const publisher = new FakePublisher();
    const dispatcher = new AnnouncementDispatcher({ channels, publisher, log: silentLogger });

    assert.equal(await dispatcher.handle(announcement('evt-2', 'nowhere')), 'unmapped');
    assert.equal(publisher.posts.length, 0);
  });

  test('頻道推播一律公開,即使描述說 ephemeral', async () => {
    const publisher = new FakePublisher();
    const dispatcher = new AnnouncementDispatcher({ channels, publisher, log: silentLogger });

    await dispatcher.handle(
      create(AnnouncementSchema, {
        eventId: 'evt-3',
        channelKey: 'announcements',
        view: create(ViewSchema, { title: 'x', ephemeral: true }),
      }),
    );
    assert.equal(publisher.posts[0]?.payload.ephemeral, false);
  });

  test('去重表滿了會淘汰最舊的,不會無限長大', async () => {
    const publisher = new FakePublisher();
    const dispatcher = new AnnouncementDispatcher({
      channels,
      publisher,
      log: silentLogger,
      dedupeSize: 2,
    });

    await dispatcher.handle(announcement('a'));
    await dispatcher.handle(announcement('b'));
    await dispatcher.handle(announcement('c'));
    // a 已經被擠出去,所以會被當成新的
    assert.equal(await dispatcher.handle(announcement('a')), 'posted');
    assert.equal(await dispatcher.handle(announcement('c')), 'duplicate');
  });

  test('一則貼不出去不會讓整個消費者停掉', async () => {
    const publisher = new FakePublisher();
    const dispatcher = new AnnouncementDispatcher({ channels, publisher, log: silentLogger });
    const source = new MemoryAnnouncementSource();
    dispatcher.attach(source);

    publisher.failNext = true;
    await source.emit(announcement('bad'));
    await source.emit(announcement('good'));

    assert.equal(publisher.posts.length, 1);
    assert.equal(publisher.posts[0]?.payload.embeds.length, 1);
  });

  test('退訂之後不再收到事件', async () => {
    const publisher = new FakePublisher();
    const dispatcher = new AnnouncementDispatcher({ channels, publisher, log: silentLogger });
    const source = new MemoryAnnouncementSource();
    const unsubscribe = dispatcher.attach(source);

    unsubscribe();
    await source.emit(announcement('x'));
    assert.equal(publisher.posts.length, 0);
    assert.equal(source.subscriberCount, 0);
  });
});

describe('規則頻道公告', () => {
  test('文案有講到語音、訊息內容的條件、以及退出方式', async () => {
    const publisher = new FakePublisher();
    const dispatcher = new AnnouncementDispatcher({ channels, publisher, log: silentLogger });

    await dispatcher.handle(rulesAnnouncement());

    const embed = publisher.posts[0]?.payload.embeds[0] as {
      fields: { name: string; value: string }[];
    };
    const text = embed.fields.map((f) => `${f.name} ${f.value}`).join('\n');
    assert.match(text, /語音/);
    assert.match(text, /只有在管理員開啟記錄的頻道/);
    assert.match(text, /privacy optout/);
    // 退出記錄 != 退出計分。文案寫成「完全不記錄我」會讓人以為自己放棄了 XP。
    assert.match(text, /退出記錄不等於退出計分/);
    assert.match(text, /完全不受影響/);
  });

  test('event_id 固定,所以重開機重貼會被去重擋掉', async () => {
    const publisher = new FakePublisher();
    const dispatcher = new AnnouncementDispatcher({ channels, publisher, log: silentLogger });

    assert.equal(await dispatcher.handle(rulesAnnouncement()), 'posted');
    assert.equal(await dispatcher.handle(rulesAnnouncement()), 'duplicate');
  });
});
