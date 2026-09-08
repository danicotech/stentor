// 互動主流程的測試。
//
// 這裡驗的就是任務書那句話:**收到 X 互動 → 呼叫 Y API → 渲染出 Z 元件。**
// 全程沒有 Discord、沒有 token、沒有網路。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { create } from '@bufbuild/protobuf';
import { ButtonStyle, ComponentType } from 'discord.js';

import {
  ActionStyle,
  ModalSchema,
  RenderResultSchema,
  ViewSchema,
} from '../src/gen/hestia/render/v1/render_pb.ts';
import type { RenderResult } from '../src/gen/hestia/render/v1/render_pb.ts';
import { Dispatcher, type RenderBackend } from '../src/gateway/dispatcher.ts';
import type { IncomingInteraction } from '../src/gateway/interaction.ts';
import type { Route } from '../src/routing/registry.ts';
import { buildRegistry } from '../src/routing/bootstrap.ts';
import { silentLogger } from '../src/shared/log.ts';
import { command, component, FakeResponder } from './helpers.ts';

interface Recorded {
  readonly method: 'command' | 'component';
  readonly route: Route;
  readonly interaction: IncomingInteraction;
}

class FakeBackend implements RenderBackend {
  readonly calls: Recorded[] = [];

  constructor(private readonly reply: RenderResult | (() => Promise<RenderResult>)) {}

  #answer(): Promise<RenderResult> {
    return typeof this.reply === 'function' ? this.reply() : Promise.resolve(this.reply);
  }

  handleCommand(route: Route, interaction: IncomingInteraction): Promise<RenderResult> {
    this.calls.push({ method: 'command', route, interaction });
    return this.#answer();
  }

  handleComponent(route: Route, interaction: IncomingInteraction): Promise<RenderResult> {
    this.calls.push({ method: 'component', route, interaction });
    return this.#answer();
  }
}

function viewResult(title: string, updateSource = false): RenderResult {
  return create(RenderResultSchema, {
    kind: {
      case: 'view',
      value: create(ViewSchema, {
        title,
        actions: [{ id: 'summer-cup:bet:1', label: '押', style: ActionStyle.PRIMARY }],
      }),
    },
    updateSource,
  });
}

function build(
  platform: RenderBackend,
  activity: RenderBackend,
  deferAfterMs = 60_000,
): Dispatcher {
  return new Dispatcher({
    registry: buildRegistry([
      { prefix: 'summer-cup', kind: 'activity', baseUrl: 'http://themis:8080' },
    ]),
    backends: { platform, activity },
    log: silentLogger,
    deferAfterMs,
  });
}

describe('dispatcher', () => {
  test('平台指令 → 平台後端 → 渲染成 embed + 按鈕', async () => {
    const platform = new FakeBackend(viewResult('簽到成功'));
    const activity = new FakeBackend(viewResult('不該被呼叫'));
    const responder = new FakeResponder();

    await build(platform, activity).dispatch(command('daily'), responder);

    assert.equal(platform.calls.length, 1);
    assert.equal(activity.calls.length, 0);
    assert.deepEqual(responder.ops, ['send']);

    const payload = responder.lastMessage();
    assert.equal((payload.embeds[0] as { title: string }).title, '簽到成功');
    assert.equal(payload.components[0]?.components[0]?.type, ComponentType.Button);
    assert.equal(
      (payload.components[0]?.components[0] as { style: number }).style,
      ButtonStyle.Primary,
    );
  });

  test('活動按鈕 → 活動後端,custom_id 原封不動送過去', async () => {
    const platform = new FakeBackend(viewResult('不該被呼叫'));
    const activity = new FakeBackend(viewResult('下注成功'));
    const responder = new FakeResponder();

    await build(platform, activity).dispatch(component('summer-cup:bet:5:1'), responder);

    assert.equal(platform.calls.length, 0);
    assert.equal(activity.calls.length, 1);
    const call = activity.calls[0];
    assert.equal(call?.method, 'component');
    assert.equal(call?.route.prefix, 'summer-cup');
    assert.equal(
      call?.interaction.customId,
      'summer-cup:bet:5:1',
      'dispatcher 不該動 custom_id 的內容',
    );
  });

  test('沒註冊的前綴不會呼叫任何後端,而是回一則可以看的訊息', async () => {
    const platform = new FakeBackend(viewResult('x'));
    const activity = new FakeBackend(viewResult('x'));
    const responder = new FakeResponder();

    await build(platform, activity).dispatch(component('winter-cup:bet'), responder);

    assert.equal(platform.calls.length + activity.calls.length, 0);
    assert.deepEqual(responder.ops, ['send']);
    assert.match((responder.lastMessage().embeds[0] as { title: string }).title, /沒有作用/);
  });

  test('後端丟例外 → 使用者看到通用錯誤,不是堆疊', async () => {
    const boom = new FakeBackend(() => Promise.reject(new Error('資料庫爆炸 at 10.0.0.5')));
    const responder = new FakeResponder();

    await build(boom, boom).dispatch(command('daily'), responder);

    const embed = responder.lastMessage().embeds[0] as { title: string; description: string };
    assert.equal(embed.title, '出了點狀況');
    assert.doesNotMatch(embed.description, /10\.0\.0\.5/, '內部細節不該外洩');
  });

  test('後端夠快時不 defer(否則 modal 就永遠開不了)', async () => {
    const modal = create(RenderResultSchema, {
      kind: { case: 'modal', value: create(ModalSchema, { id: 'summer-cup:f', title: '下注' }) },
    });
    const backend = new FakeBackend(modal);
    const responder = new FakeResponder();

    await build(backend, backend).dispatch(component('summer-cup:form'), responder);

    assert.deepEqual(responder.ops, ['openModal']);
  });

  test('後端太慢時先 defer 卡位,回來再送內容', async () => {
    const slow = new FakeBackend(
      () => new Promise((resolve) => setTimeout(() => resolve(viewResult('慢但成功')), 20)),
    );
    const responder = new FakeResponder();

    await build(slow, slow, 0).dispatch(command('daily'), responder);

    assert.deepEqual(responder.ops, ['defer', 'send']);
    assert.equal(responder.calls[0]?.options?.ephemeral, true, '平台指令預設只有自己看得到');
  });

  test('已經 defer 又想開表單 → 降級成提示,不是互動失敗', async () => {
    const slowModal = new FakeBackend(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve(
                create(RenderResultSchema, {
                  kind: {
                    case: 'modal',
                    value: create(ModalSchema, { id: 'summer-cup:f', title: 'x' }),
                  },
                }),
              ),
            20,
          ),
        ),
    );
    const responder = new FakeResponder();

    await build(slowModal, slowModal, 0).dispatch(component('summer-cup:f'), responder);

    assert.deepEqual(responder.ops, ['defer', 'send']);
    assert.match((responder.lastMessage().embeds[0] as { title: string }).title, /再按一次/);
  });

  test('update_source + 已 defer → 就地更新原訊息', async () => {
    const backend = new FakeBackend(
      () => new Promise((resolve) => setTimeout(() => resolve(viewResult('更新了', true)), 20)),
    );
    const responder = new FakeResponder();

    const dispatcher = new Dispatcher({
      registry: buildRegistry([
        {
          prefix: 'summer-cup',
          kind: 'activity',
          baseUrl: 'http://x.example',
          updatesSource: true,
        },
      ]),
      backends: { platform: backend, activity: backend },
      log: silentLogger,
      deferAfterMs: 0,
    });
    await dispatcher.dispatch(component('summer-cup:bet:1'), responder);

    assert.deepEqual(responder.ops, ['defer', 'editSource']);
    assert.equal(responder.calls[0]?.options?.update, true);
  });

  test('後端回了空的 RenderResult → 錯誤訊息,不是空白訊息', async () => {
    const empty = new FakeBackend(create(RenderResultSchema, {}));
    const responder = new FakeResponder();

    await build(empty, empty).dispatch(command('daily'), responder);

    assert.match((responder.lastMessage().embeds[0] as { title: string }).title, /出了點狀況/);
  });
});
