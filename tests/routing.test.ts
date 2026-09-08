// 路由的測試。
//
// 這是這個 repo 唯一「壞掉就整個沒意義」的機制,所以測得比別的地方細:
// 前綴解析、註冊衝突、指令與元件走同一張表、以及那句招牌
// 「加一個新活動不用改這個 repo」是不是真的成立。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCustomId,
  commandNamespace,
  CustomIdError,
  CUSTOM_ID_MAX_BYTES,
  parseCustomId,
} from '../src/routing/custom-id.ts';
import { RouteConflictError, RouteRegistry } from '../src/routing/registry.ts';
import { route } from '../src/routing/router.ts';
import { buildRegistry } from '../src/routing/bootstrap.ts';
import { parseActivityRoutes, parseChannelMap, RouteConfigError } from '../src/config/routes.ts';
import { PLATFORM_PREFIXES } from '../src/commands/platform-backend.ts';
import { command, component } from './helpers.ts';

describe('custom_id', () => {
  test('第一段就是路由鍵,其餘原封不動交給活動服務', () => {
    const parsed = parseCustomId('summer-cup:bet:5:1');
    assert.equal(parsed.prefix, 'summer-cup');
    assert.deepEqual(parsed.segments, ['bet', '5', '1']);
  });

  test('沒有分隔字元時整串就是前綴', () => {
    assert.equal(parseCustomId('daily').prefix, 'daily');
  });

  test('超過 Discord 的 100 bytes 上限就拒絕', () => {
    const long = 'a'.repeat(CUSTOM_ID_MAX_BYTES + 1);
    assert.throws(() => parseCustomId(long), CustomIdError);
  });

  test('長度算的是 bytes 不是字元(中文一個字 3 bytes)', () => {
    const chinese = 'a:' + '賽'.repeat(34); // 2 + 102 bytes
    assert.throws(() => parseCustomId(chinese), CustomIdError);
  });

  test('不合法的前綴直接拒絕', () => {
    assert.throws(() => parseCustomId('Summer-Cup:bet'), CustomIdError);
    assert.throws(() => parseCustomId(':bet'), CustomIdError);
    assert.throws(() => parseCustomId(''), CustomIdError);
  });

  test('組出來的 id 不能讓段自己塞分隔字元(否則會偽造路由)', () => {
    assert.equal(buildCustomId('shop', 'buy', '01H'), 'shop:buy:01H');
    assert.throws(() => buildCustomId('shop', 'buy:evil'), CustomIdError);
  });

  test('指令命名空間取第一段', () => {
    assert.equal(commandNamespace('privacy optout'), 'privacy');
    assert.equal(commandNamespace('daily'), 'daily');
    assert.equal(commandNamespace('  summer-cup   bet '), 'summer-cup');
  });
});

describe('註冊表', () => {
  test('重複註冊同一個前綴會爆(而且是啟動時)', () => {
    const registry = new RouteRegistry();
    registry.register({ prefix: 'shop', kind: 'platform' });
    assert.throws(
      () => registry.register({ prefix: 'shop', kind: 'activity', baseUrl: 'http://x' }),
      RouteConflictError,
    );
  });

  test('活動路由沒有 base URL 就拒絕', () => {
    const registry = new RouteRegistry();
    assert.throws(() => registry.register({ prefix: 'cup', kind: 'activity' }), /base URL/);
  });

  test('平台前綴全部都在預設註冊表裡', () => {
    const registry = buildRegistry([]);
    for (const prefix of PLATFORM_PREFIXES) {
      assert.ok(registry.has(prefix), `缺少平台前綴 ${prefix}`);
    }
  });

  test('活動撞到平台前綴會開不起來', () => {
    assert.throws(
      () => buildRegistry([{ prefix: 'shop', kind: 'activity', baseUrl: 'http://x' }]),
      RouteConflictError,
    );
  });
});

describe('路由決策', () => {
  const registry = buildRegistry([
    { prefix: 'summer-cup', kind: 'activity', baseUrl: 'http://themis:8080' },
  ]);

  test('指令依命名空間路由', () => {
    const resolved = route(registry, command('privacy optout', { level: 'logging' }));
    assert.ok(resolved.ok);
    assert.equal(resolved.route.prefix, 'privacy');
    assert.equal(resolved.route.kind, 'platform');
    assert.deepEqual(resolved.segments, ['optout']);
  });

  test('元件依 custom_id 前綴路由到活動服務', () => {
    const resolved = route(registry, component('summer-cup:bet:5:1'));
    assert.ok(resolved.ok);
    assert.equal(resolved.route.kind, 'activity');
    assert.equal(resolved.route.baseUrl, 'http://themis:8080');
    assert.deepEqual(resolved.segments, ['bet', '5', '1']);
  });

  test('指令與按鈕走同一張表:同一個前綴兩邊都通', () => {
    const byCommand = route(registry, command('summer-cup bet'));
    const byComponent = route(registry, component('summer-cup:bet'));
    assert.ok(byCommand.ok && byComponent.ok);
    assert.equal(byCommand.route.prefix, byComponent.route.prefix);
  });

  test('沒註冊的前綴不會丟例外,而是回一個可以顯示的結果', () => {
    const resolved = route(registry, component('winter-cup:bet'));
    assert.equal(resolved.ok, false);
    if (!resolved.ok) assert.equal(resolved.reason, 'unknown-prefix');
  });

  test('壞掉的 custom_id 回 malformed 而不是炸掉', () => {
    const resolved = route(registry, component('X'.repeat(200)));
    assert.equal(resolved.ok, false);
    if (!resolved.ok) assert.equal(resolved.reason, 'malformed');
  });
});

describe('ACTIVITY_ROUTES 設定', () => {
  test('基本格式', () => {
    const routes = parseActivityRoutes('summer-cup=http://themis:8080');
    assert.equal(routes.length, 1);
    assert.equal(routes[0]?.prefix, 'summer-cup');
    assert.equal(routes[0]?.baseUrl, 'http://themis:8080');
    assert.equal(routes[0]?.ephemeral, true, '預設應該只有自己看得到');
  });

  test('旗標', () => {
    const routes = parseActivityRoutes('cup=https://a.example;public;update');
    assert.equal(routes[0]?.ephemeral, false);
    assert.equal(routes[0]?.updatesSource, true);
  });

  test('多個活動', () => {
    const routes = parseActivityRoutes('a=http://a.example, b=http://b.example;public');
    assert.deepEqual(
      routes.map((r) => r.prefix),
      ['a', 'b'],
    );
  });

  test('空字串 = 沒有活動(M1 的正常狀態)', () => {
    assert.deepEqual(parseActivityRoutes('  '), []);
  });

  test('錯字在啟動時就爆,不會變成線上的「按鈕沒反應」', () => {
    assert.throws(() => parseActivityRoutes('nope'), RouteConfigError);
    assert.throws(() => parseActivityRoutes('Cup=http://x'), RouteConfigError);
    assert.throws(() => parseActivityRoutes('cup=not-a-url'), RouteConfigError);
    assert.throws(() => parseActivityRoutes('cup=ftp://x'), RouteConfigError);
    assert.throws(() => parseActivityRoutes('cup=http://x;bogus'), RouteConfigError);
    assert.throws(() => parseActivityRoutes('cup=http://a,cup=http://b'), RouteConfigError);
  });
});

describe('CHANNEL_MAP 設定', () => {
  test('邏輯名 → channel id', () => {
    const map = parseChannelMap('announcements=123456789012345678,rules=234567890123456789');
    assert.equal(map.get('announcements'), '123456789012345678');
    assert.equal(map.size, 2);
  });

  test('不像 snowflake 的 id 直接拒絕', () => {
    assert.throws(() => parseChannelMap('rules=abc'), /snowflake/);
  });
});
