// 渲染契約的測試。
//
// 核心斷言只有一句:**同一份描述 → 穩定的 Discord 元件。**
// 所以這裡大量用 deepEqual 對整個 payload,而不是只戳幾個欄位——
// 「多冒出一個屬性」也是行為改變,測試該擋下來。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { create } from '@bufbuild/protobuf';
import { ButtonStyle, ComponentType, MessageFlags } from 'discord.js';

import { ActionStyle, ModalSchema, ViewSchema } from '../src/gen/hestia/render/v1/render_pb.ts';
import { renderModal, renderView, toDiscordMessage } from '../src/render/view.ts';
import { LIMITS } from '../src/render/limits.ts';

/** CLAUDE.md 開頭那份範例描述,原封不動。 */
function sampleView() {
  return create(ViewSchema, {
    title: '阿凱 對 小美',
    fields: [{ k: '賠率', v: '1.43 / 2.58' }],
    actions: [{ id: 'summer-cup:bet:5:1', label: '押 阿凱', style: ActionStyle.PRIMARY }],
  });
}

describe('View → Discord 元件', () => {
  test('CLAUDE.md 的範例描述渲染成預期的元件', () => {
    const { payload, warnings } = renderView(sampleView());
    assert.deepEqual(warnings, []);
    assert.deepEqual(payload, {
      content: '',
      ephemeral: false,
      embeds: [
        {
          title: '阿凱 對 小美',
          fields: [{ name: '賠率', value: '1.43 / 2.58', inline: false }],
        },
      ],
      components: [
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.Button,
              style: ButtonStyle.Primary,
              label: '押 阿凱',
              custom_id: 'summer-cup:bet:5:1',
              disabled: false,
            },
          ],
        },
      ],
    });
  });

  test('同一份描述渲染兩次結果完全一樣(純函式)', () => {
    const view = sampleView();
    assert.deepEqual(renderView(view).payload, renderView(view).payload);
  });

  test('空欄位不會冒出來(沒有 title 就沒有 title 屬性)', () => {
    const { payload } = renderView(create(ViewSchema, { description: '只有描述' }));
    assert.deepEqual(payload.embeds, [{ description: '只有描述' }]);
  });

  test('按鈕每 5 顆一行,活動服務不必知道這件事', () => {
    const view = create(ViewSchema, {
      actions: Array.from({ length: 7 }, (_, i) => ({
        id: `cup:b:${i}`,
        label: `按鈕 ${i}`,
        style: ActionStyle.SECONDARY,
      })),
    });
    const { payload } = renderView(view);
    assert.equal(payload.components.length, 2);
    assert.equal(payload.components[0]?.components.length, 5);
    assert.equal(payload.components[1]?.components.length, 2);
  });

  test('下拉選單排在按鈕前面,而且各自獨佔一行', () => {
    const view = create(ViewSchema, {
      selects: [{ id: 'cup:pick', placeholder: '選一個', options: [{ value: 'a', label: 'A' }] }],
      actions: [{ id: 'cup:go', label: '送出', style: ActionStyle.SUCCESS }],
    });
    const { payload } = renderView(view);
    assert.equal(payload.components[0]?.components[0]?.type, ComponentType.StringSelect);
    assert.equal(payload.components[1]?.components[0]?.type, ComponentType.Button);
  });

  test('超過 5 行的元件被丟掉,而且會說出來', () => {
    const view = create(ViewSchema, {
      selects: Array.from({ length: 6 }, (_, i) => ({
        id: `cup:s${i}`,
        options: [{ value: 'a', label: 'A' }],
      })),
    });
    const { payload, warnings } = renderView(view);
    assert.equal(payload.components.length, LIMITS.actionRows);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] as string, /上限 5/);
  });

  test('custom_id 太長的按鈕整顆丟掉——截斷會讓它路由到別的地方', () => {
    const view = create(ViewSchema, {
      actions: [
        { id: 'cup:' + 'x'.repeat(200), label: '壞的', style: ActionStyle.PRIMARY },
        { id: 'cup:ok', label: '好的', style: ActionStyle.PRIMARY },
      ],
    });
    const { payload, warnings } = renderView(view);
    assert.equal(payload.components[0]?.components.length, 1);
    assert.match(warnings[0] as string, /custom_id 超過/);
  });

  test('LINK 按鈕沒有 url 就丟掉', () => {
    const view = create(ViewSchema, {
      actions: [{ id: '', label: '外連', style: ActionStyle.LINK }],
    });
    const { payload, warnings } = renderView(view);
    assert.deepEqual(payload.components, []);
    assert.match(warnings[0] as string, /沒有 url/);
  });

  test('LINK 按鈕不需要 custom_id', () => {
    const view = create(ViewSchema, {
      actions: [{ id: '', label: '看規則', style: ActionStyle.LINK, url: 'https://example.com' }],
    });
    const { payload, warnings } = renderView(view);
    assert.deepEqual(warnings, []);
    assert.deepEqual(payload.components[0]?.components[0], {
      type: ComponentType.Button,
      style: ButtonStyle.Link,
      label: '看規則',
      url: 'https://example.com',
      disabled: false,
    });
  });

  test('沒指定 style 的按鈕退成 Secondary,不會變成非法元件', () => {
    const view = create(ViewSchema, { actions: [{ id: 'cup:a', label: 'A' }] });
    const { payload } = renderView(view);
    const button = payload.components[0]?.components[0] as { style: number };
    assert.equal(button.style, ButtonStyle.Secondary);
  });

  test('過長的文字被截斷而不是丟例外', () => {
    const view = create(ViewSchema, { title: 'あ'.repeat(400) });
    const { payload } = renderView(view);
    const title = (payload.embeds[0] as { title: string }).title;
    assert.equal(title.length, LIMITS.embedTitle);
    assert.ok(title.endsWith('…'));
  });

  test('欄位超過 25 個只留前 25 個並警告', () => {
    const view = create(ViewSchema, {
      fields: Array.from({ length: 30 }, (_, i) => ({ k: `k${i}`, v: `v${i}` })),
    });
    const { payload, warnings } = renderView(view);
    assert.equal((payload.embeds[0] as { fields: unknown[] }).fields.length, 25);
    assert.equal(warnings.length, 1);
  });

  test('自訂 emoji 解析成 id/name/animated', () => {
    const view = create(ViewSchema, {
      actions: [{ id: 'cup:a', label: 'A', style: ActionStyle.PRIMARY, emoji: '<a:hype:123>' }],
    });
    const { payload } = renderView(view);
    const button = payload.components[0]?.components[0] as { emoji: unknown };
    assert.deepEqual(button.emoji, { id: '123', name: 'hype', animated: true });
  });

  test('ephemeral 會翻成 Discord 的 flags', () => {
    const view = create(ViewSchema, { title: '只有你看得到', ephemeral: true });
    const body = toDiscordMessage(renderView(view).payload);
    assert.equal(body['flags'], MessageFlags.Ephemeral);
  });

  test('非 ephemeral 不會出現 flags', () => {
    const body = toDiscordMessage(renderView(sampleView()).payload);
    assert.equal('flags' in body, false);
  });
});

describe('Modal → Discord 表單', () => {
  test('輸入欄渲染成一欄一行', () => {
    const modal = create(ModalSchema, {
      id: 'cup:bet-form',
      title: '下注',
      inputs: [{ id: 'amount', label: '金額', required: true, maxLength: 10 }],
    });
    const { payload, warnings } = renderModal(modal);
    assert.deepEqual(warnings, []);
    assert.deepEqual(payload, {
      custom_id: 'cup:bet-form',
      title: '下注',
      components: [
        {
          type: ComponentType.ActionRow,
          components: [
            {
              type: ComponentType.TextInput,
              custom_id: 'amount',
              label: '金額',
              style: 1,
              required: true,
              max_length: 10,
            },
          ],
        },
      ],
    });
  });

  test('超過 5 個欄位只留前 5 個', () => {
    const modal = create(ModalSchema, {
      id: 'cup:f',
      title: 'x',
      inputs: Array.from({ length: 8 }, (_, i) => ({ id: `i${i}`, label: `L${i}` })),
    });
    const { payload, warnings } = renderModal(modal);
    assert.equal(payload.components.length, LIMITS.modalInputs);
    assert.equal(warnings.length, 1);
  });
});
