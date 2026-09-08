// 平台指令的測試。
//
// 驗兩件事:
//   1. 每一次呼叫都帶了 `X-Acting-User: discord:<id>` —— 少了它 hestia 不知道
//      這是代表誰做的,而那是整個身分模型的支點
//   2. hestia 回什麼 → 使用者看到什麼(含錯誤碼的翻譯)
//
// hestia 的 client 是假的:這裡沒有網路,也沒有 service token。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { Code, ConnectError } from '@connectrpc/connect';
import { ButtonStyle } from 'discord.js';

import { PlatformBackend } from '../src/commands/platform-backend.ts';
import { loginUrl } from '../src/commands/bind.ts';
import type { PlatformClients } from '../src/platform/client.ts';
import { PlatformCapabilityUnavailable, unavailablePorts } from '../src/platform/ports.ts';
import type { PlatformPorts } from '../src/platform/ports.ts';
import { renderView } from '../src/render/view.ts';
import type { MessagePayload } from '../src/render/view.ts';
import type { Route } from '../src/routing/registry.ts';
import { command, component } from './helpers.ts';

const platformRoute = (prefix: string): Route => ({
  prefix,
  kind: 'platform',
  baseUrl: null,
  ephemeral: true,
  updatesSource: false,
});

interface Recorded {
  readonly rpc: string;
  readonly request: unknown;
  readonly headers: Record<string, string> | undefined;
}

function fakeClients(
  impl: Record<string, Record<string, (req: unknown) => unknown>>,
  recorded: Recorded[],
): PlatformClients {
  const proxy = (service: string): Record<string, unknown> =>
    new Proxy(
      {},
      {
        get: (_t, rpc: string) => (req: unknown, opts?: { headers?: Record<string, string> }) => {
          recorded.push({ rpc: `${service}.${rpc}`, request: req, headers: opts?.headers });
          const fn = impl[service]?.[rpc];
          if (!fn) throw new Error(`測試沒有準備 ${service}.${rpc} 的回應`);
          return Promise.resolve(fn(req));
        },
      },
    );
  return {
    daily: proxy('daily'),
    me: proxy('me'),
    shop: proxy('shop'),
    activity: proxy('activity'),
  } as unknown as PlatformClients;
}

const WEB_BASE_URL = 'https://play.example';

function backendWith(
  impl: Record<string, Record<string, (req: unknown) => unknown>>,
  ports: PlatformPorts = unavailablePorts,
): { backend: PlatformBackend; recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  return {
    backend: new PlatformBackend({
      clients: fakeClients(impl, recorded),
      ports,
      webBaseUrl: WEB_BASE_URL,
    }),
    recorded,
  };
}

type ResultLike = { kind: { case?: string | undefined; value?: unknown } };

function titleOf(result: ResultLike): string {
  assert.equal(result.kind.case, 'view');
  const { payload } = renderView(result.kind.value as never);
  return (payload.embeds[0] as { title?: string }).title ?? '';
}

function payloadOf(result: ResultLike): MessagePayload {
  return renderView(result.kind.value as never).payload;
}

function fieldsOf(result: ResultLike): { name: string; value: string }[] {
  const { payload } = renderView(result.kind.value as never);
  const fields = (payload.embeds[0] as { fields?: { name: string; value: string }[] }).fields ?? [];
  // inline 是排版,不是內容;測內容的斷言不該綁著它。
  return fields.map((f) => ({ name: f.name, value: f.value }));
}

describe('/daily', () => {
  test('呼叫 DailyService.Claim 並帶 X-Acting-User', async () => {
    const { backend, recorded } = backendWith({
      daily: { claim: () => ({ amount: 1500n, streak: 7 }) },
    });

    const result = await backend.handleCommand(platformRoute('daily'), command('daily'));

    assert.equal(recorded[0]?.rpc, 'daily.claim');
    assert.deepEqual(recorded[0]?.headers, { 'X-Acting-User': 'discord:100000000000000001' });
    assert.equal(titleOf(result), '簽到成功');
    assert.deepEqual(fieldsOf(result), [
      { name: '本次獲得', value: '1,500' },
      { name: '連續天數', value: '7 天' },
    ]);
  });

  test('今天簽過了 → AlreadyExists 翻成「已經做過了」', async () => {
    const { backend } = backendWith({
      daily: {
        claim: () => {
          throw new ConnectError('already claimed', Code.AlreadyExists);
        },
      },
    });

    const result = await backend.handleCommand(platformRoute('daily'), command('daily'));
    assert.match(titleOf(result), /已經做過了/);
  });

  test('Unauthenticated 是服務 token 壞掉,不該叫使用者去登入', async () => {
    // 走代打這條路,「使用者沒綁」是 FailedPrecondition;Unauthenticated 只會
    // 來自服務 token 本身無效 —— 那時叫使用者去登入,他做什麼都沒用。
    const { backend } = backendWith({
      daily: {
        claim: () => {
          throw new ConnectError('no identity', Code.Unauthenticated);
        },
      },
    });

    const result = await backend.handleCommand(platformRoute('daily'), command('daily'));
    assert.match(titleOf(result), /設定有問題/);
    assert.doesNotMatch(titleOf(result), /綁定/);
  });
});

describe('/balance', () => {
  test('多幣別一次列出,金額不做任何計算只做分位', async () => {
    const { backend, recorded } = backendWith({
      me: {
        listBalances: () => ({
          balances: [
            { currency: 'PT', amount: 1234567n },
            { currency: 'GEM', amount: 0n },
          ],
        }),
      },
    });

    const result = await backend.handleCommand(platformRoute('balance'), command('balance'));

    assert.equal(recorded[0]?.rpc, 'me.listBalances');
    assert.deepEqual(fieldsOf(result), [
      { name: 'PT', value: '1,234,567' },
      { name: 'GEM', value: '0' },
    ]);
  });

  test('沒有餘額也要有話可說', async () => {
    const { backend } = backendWith({ me: { listBalances: () => ({ balances: [] }) } });
    const result = await backend.handleCommand(platformRoute('balance'), command('balance'));
    assert.equal(titleOf(result), '餘額');
  });
});

describe('/shop', () => {
  const items = {
    shop: {
      listItems: () => ({
        items: [
          {
            publicId: '01HZX0000000000000000001',
            name: '限定身分組',
            description: '好看',
            currency: 'PT',
            price: 500n,
            durationDays: 30,
            perUserLimit: 1,
          },
        ],
      }),
      purchase: () => ({
        itemPublicId: '01HZX0000000000000000001',
        currency: 'PT',
        price: 500n,
        entitlementPublicId: '01HZY0000000000000000002',
        redemptionPublicId: '',
        replayed: false,
      }),
    },
  };

  test('每個商品產生一顆按鈕,custom_id 是 shop:buy:<public_id>', async () => {
    const { backend } = backendWith(items);
    const result = await backend.handleCommand(platformRoute('shop'), command('shop'));

    const { payload } = renderView((result as ResultLike).kind.value as never);
    const button = payload.components[0]?.components[0] as { custom_id: string };
    assert.equal(button.custom_id, 'shop:buy:01HZX0000000000000000001');
  });

  test('按下購買 → Purchase,冪等鍵綁 interaction id', async () => {
    const { backend, recorded } = backendWith(items);

    const result = await backend.handleComponent(
      platformRoute('shop'),
      component('shop:buy:01HZX0000000000000000001'),
    );

    assert.equal(recorded[0]?.rpc, 'shop.purchase');
    assert.deepEqual(recorded[0]?.request, {
      itemPublicId: '01HZX0000000000000000001',
      idempotencyKey: 'discord-interaction:interaction-1',
    });
    assert.equal(titleOf(result), '購買成功');
  });

  test('餘額不足 → FailedPrecondition,不是通用錯誤', async () => {
    const { backend } = backendWith({
      shop: {
        purchase: () => {
          throw new ConnectError('餘額不足', Code.FailedPrecondition);
        },
      },
    });

    const result = await backend.handleComponent(
      platformRoute('shop'),
      component('shop:buy:01HZX0000000000000000001'),
    );
    assert.match(titleOf(result), /現在還不能/);
  });

  test('不認得的 shop 按鈕不會打任何 API', async () => {
    const { backend, recorded } = backendWith({});
    const result = await backend.handleComponent(platformRoute('shop'), component('shop:nope'));
    assert.equal(recorded.length, 0);
    assert.match(titleOf(result), /沒有作用/);
  });
});

describe('hestia 還沒提供的能力', () => {
  test('/privacy optout 回「還沒開放」而不是假裝成功', async () => {
    const { backend } = backendWith({});
    const result = await backend.handleCommand(
      platformRoute('privacy'),
      command('privacy optout', { level: 'logging' }),
    );
    assert.match(titleOf(result), /還沒開放/);
  });

  test('接上實作之後 /privacy optout 就會通(介面已經定死)', async () => {
    const calls: string[] = [];
    const ports: PlatformPorts = {
      privacy: {
        get: () => Promise.resolve({ level: 'none' as const }),
        set: (userId, level) => {
          calls.push(`${userId}:${level}`);
          return Promise.resolve({ level });
        },
      },
    };
    const { backend } = backendWith({}, ports);

    const result = await backend.handleCommand(
      platformRoute('privacy'),
      command('privacy optout', { level: 'corpus' }),
    );

    assert.deepEqual(calls, ['100000000000000001:corpus']);
    assert.match(titleOf(result), /已更新/);
  });

  test('unavailablePorts 丟的是有型別的例外,不是字串', async () => {
    await assert.rejects(() => unavailablePorts.privacy.get('1'), PlatformCapabilityUnavailable);
  });
});

describe('/privacy notice', () => {
  test('不打任何 API,直接吐資料告知文案', async () => {
    const { backend, recorded } = backendWith({});
    const result = await backend.handleCommand(platformRoute('privacy'), command('privacy notice'));
    assert.equal(recorded.length, 0);
    assert.match(titleOf(result), /記錄哪些資料/);
  });
});

describe('/bind', () => {
  test('不打任何 API —— 綁定發生在使用者自己的瀏覽器裡', async () => {
    const { backend, recorded } = backendWith({});
    const result = await backend.handleCommand(platformRoute('bind'), command('bind'));
    assert.equal(recorded.length, 0);
    assert.match(titleOf(result), /怎麼綁定帳號/);
  });

  test('給的是登入頁的連結按鈕,base URL 來自設定不寫死', async () => {
    const { backend } = backendWith({});
    const result = await backend.handleCommand(platformRoute('bind'), command('bind'));

    const button = payloadOf(result).components[0]?.components[0] as {
      style: number;
      url: string;
      custom_id?: string;
    };
    assert.equal(button.style, ButtonStyle.Link);
    assert.equal(button.url, 'https://play.example/login');
    assert.equal(button.custom_id, undefined, '外連按鈕沒有 custom_id,也不會回呼');
  });

  test('文案不提任何代碼,而且說明為什麼要用自己的瀏覽器', async () => {
    const { backend } = backendWith({});
    const result = await backend.handleCommand(platformRoute('bind'), command('bind'));
    const embed = payloadOf(result).embeds[0] as {
      description: string;
      fields: { name: string; value: string }[];
    };
    assert.match(embed.description, /不需要輸入任何代碼/);
    assert.match(embed.fields.map((f) => f.value).join(' '), /憑證/);
  });

  test('只有自己看得到', async () => {
    const { backend } = backendWith({});
    const result = await backend.handleCommand(platformRoute('bind'), command('bind'));
    assert.equal(payloadOf(result).ephemeral, true);
  });

  test('loginUrl 會處理結尾斜線', () => {
    assert.equal(loginUrl('https://play.example'), 'https://play.example/login');
    assert.equal(loginUrl('https://play.example/'), 'https://play.example/login');
  });
});

describe('代打對象還沒綁定', () => {
  // hestia 的代打(service token + X-Acting-User)在使用者沒綁定時回
  // FailedPrecondition,語意是「去引導綁定」而不是「重試」。
  const notLinked = () => {
    throw new ConnectError(
      'discord:100000000000000001: 這個 Discord 使用者尚未綁定平台帳號',
      Code.FailedPrecondition,
    );
  };

  test('/daily 直接給綁定指引,不是「現在還不能這樣做」', async () => {
    const { backend } = backendWith({ daily: { claim: notLinked } });
    const result = await backend.handleCommand(platformRoute('daily'), command('daily'));
    assert.match(titleOf(result), /還沒有綁定/);
    const button = payloadOf(result).components[0]?.components[0] as { url: string };
    assert.equal(button.url, 'https://play.example/login');
  });

  test('/balance 同一條路徑', async () => {
    const { backend } = backendWith({ me: { listBalances: notLinked } });
    const result = await backend.handleCommand(platformRoute('balance'), command('balance'));
    assert.match(titleOf(result), /還沒有綁定/);
  });

  test('購買時也一樣', async () => {
    const { backend } = backendWith({ shop: { purchase: notLinked } });
    const result = await backend.handleComponent(
      platformRoute('shop'),
      component('shop:buy:01HZX0000000000000000001'),
    );
    assert.match(titleOf(result), /還沒有綁定/);
  });

  test('其他 FailedPrecondition 不會被誤認成未綁定', async () => {
    const { backend } = backendWith({
      shop: {
        purchase: () => {
          throw new ConnectError('餘額不足', Code.FailedPrecondition);
        },
      },
    });
    const result = await backend.handleComponent(
      platformRoute('shop'),
      component('shop:buy:01HZX0000000000000000001'),
    );
    assert.match(titleOf(result), /現在還不能/);
    assert.deepEqual(payloadOf(result).components, [], '不該冒出登入按鈕');
  });
});
