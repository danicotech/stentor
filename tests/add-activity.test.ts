// 招牌那句話的測試:**加一個新活動,這個 repo 一行都不用改。**
//
// 這裡假裝有一個叫 summer-cup 的活動服務。它做的事(下注、賠率、階段)
// 全部在假 client 那一側,測試檔本身也不知道那些概念是什麼意思——
// 這正是重點:整條路徑上唯一提到 summer-cup 的地方是**設定字串**。

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { create } from '@bufbuild/protobuf';
import { ComponentType } from 'discord.js';

import {
  ActionStyle,
  HandleCommandResponseSchema,
  HandleComponentResponseSchema,
  RenderResultSchema,
  ViewSchema,
} from '../src/gen/hestia/render/v1/render_pb.ts';
import { ActivityBackend, type ActivityClient } from '../src/activity/backend.ts';
import { Dispatcher } from '../src/gateway/dispatcher.ts';
import { PlatformBackend } from '../src/commands/platform-backend.ts';
import type { PlatformClients } from '../src/platform/client.ts';
import { unavailablePorts } from '../src/platform/ports.ts';
import { buildRegistry } from '../src/routing/bootstrap.ts';
import { parseActivityRoutes } from '../src/config/routes.ts';
import { collectCommands } from '../src/commands/register.ts';
import { silentLogger } from '../src/shared/log.ts';
import { command, component, FakeResponder } from './helpers.ts';

/** 一個假的活動服務。它回什麼、custom_id 長什麼樣,stentor 都不需要知道。 */
function fakeActivityClient(seen: unknown[]): ActivityClient {
  return {
    describeCommands: () =>
      Promise.resolve({
        commands: [
          {
            $typeName: 'google.protobuf.Struct',
            fields: {
              name: {
                $typeName: 'google.protobuf.Value',
                kind: { case: 'stringValue', value: 'summer-cup' },
              },
              description: {
                $typeName: 'google.protobuf.Value',
                kind: { case: 'stringValue', value: '夏季盃' },
              },
            },
          },
        ],
        prefixes: ['summer-cup'],
      }),
    handleCommand: (req: unknown) => {
      seen.push(req);
      return Promise.resolve(
        create(HandleCommandResponseSchema, {
          result: create(RenderResultSchema, {
            kind: {
              case: 'view',
              value: create(ViewSchema, {
                title: '阿凱 對 小美',
                fields: [{ k: '賠率', v: '1.43 / 2.58' }],
                actions: [
                  { id: 'summer-cup:bet:5:1', label: '押 阿凱', style: ActionStyle.PRIMARY },
                ],
              }),
            },
          }),
        }),
      );
    },
    handleComponent: (req: unknown) => {
      seen.push(req);
      return Promise.resolve(
        create(HandleComponentResponseSchema, {
          result: create(RenderResultSchema, {
            kind: { case: 'view', value: create(ViewSchema, { title: '下注成功' }) },
          }),
        }),
      );
    },
  } as unknown as ActivityClient;
}

function wire(seen: unknown[]) {
  // 「加活動」的全部動作就是這一行環境變數。
  const routes = parseActivityRoutes('summer-cup=http://themis:8080');
  const registry = buildRegistry(routes);
  const activity = new ActivityBackend({
    serviceToken: 'test-token',
    clientFactory: () => fakeActivityClient(seen),
  });
  const platform = new PlatformBackend({
    clients: {} as unknown as PlatformClients,
    ports: unavailablePorts,
    webBaseUrl: 'https://play.example',
  });
  const dispatcher = new Dispatcher({
    registry,
    backends: { platform, activity },
    log: silentLogger,
    deferAfterMs: 60_000,
  });
  return { registry, activity, dispatcher };
}

describe('加一個活動', () => {
  test('只靠一行 ACTIVITY_ROUTES,指令就通了', async () => {
    const seen: unknown[] = [];
    const { dispatcher } = wire(seen);
    const responder = new FakeResponder();

    await dispatcher.dispatch(command('summer-cup bet', { amount: '100' }), responder);

    assert.equal(seen.length, 1);
    assert.deepEqual(
      { ...(seen[0] as Record<string, unknown>), $typeName: undefined },
      {
        $typeName: undefined,
        command: 'summer-cup bet',
        actor: {
          discordUserId: '100000000000000001',
          discordGuildId: '200000000000000002',
          discordChannelId: '300000000000000003',
          locale: 'zh-TW',
        },
        options: { amount: '100' },
        interactionId: 'interaction-1',
      },
    );
  });

  test('活動回的描述被渲染成 Discord 元件', async () => {
    const { dispatcher } = wire([]);
    const responder = new FakeResponder();

    await dispatcher.dispatch(command('summer-cup bet'), responder);

    const payload = responder.lastMessage();
    assert.equal((payload.embeds[0] as { title: string }).title, '阿凱 對 小美');
    assert.deepEqual((payload.embeds[0] as { fields: unknown[] }).fields, [
      { name: '賠率', value: '1.43 / 2.58', inline: false },
    ]);
    assert.equal(payload.components[0]?.components[0]?.type, ComponentType.Button);
  });

  test('那顆按鈕按下去會回到同一個活動服務', async () => {
    const seen: unknown[] = [];
    const { dispatcher } = wire(seen);
    const responder = new FakeResponder();

    await dispatcher.dispatch(component('summer-cup:bet:5:1'), responder);

    assert.equal((seen[0] as { customId: string }).customId, 'summer-cup:bet:5:1');
    assert.equal((responder.lastMessage().embeds[0] as { title: string }).title, '下注成功');
  });

  test('活動的 slash 指令由活動自己交出來,不必寫進這個 repo', async () => {
    const { registry, activity } = wire([]);
    const collected = await collectCommands(registry, activity, silentLogger);

    assert.deepEqual(collected.problems, []);
    assert.ok(
      collected.commands.some((c) => c.name === 'summer-cup'),
      '活動的指令要出現在註冊清單裡',
    );
    assert.ok(
      collected.commands.some((c) => c.name === 'daily'),
      '平台自己的指令也還在',
    );
  });

  test('活動宣告的前綴與設定不符 → 啟動時就報,不等使用者按了才發現', async () => {
    const registry = buildRegistry(parseActivityRoutes('summer-cup=http://themis:8080'));
    const activity = {
      describeCommands: () => Promise.resolve({ commands: [], prefixes: ['winter-cup'] }),
    };

    const collected = await collectCommands(registry, activity, silentLogger);
    assert.equal(collected.problems.length, 1);
    assert.match(collected.problems[0] as string, /winter-cup/);
  });

  test('活動的指令名跟前綴對不上也要擋下來', async () => {
    const registry = buildRegistry(parseActivityRoutes('summer-cup=http://themis:8080'));
    const activity = {
      describeCommands: () =>
        Promise.resolve({ commands: [{ name: 'bet' }], prefixes: ['summer-cup'] }),
    };

    const collected = await collectCommands(registry, activity, silentLogger);
    assert.match(collected.problems[0] as string, /指令名必須等於前綴/);
  });

  test('活動服務掛了不會讓整批指令註冊失敗得莫名其妙', async () => {
    const registry = buildRegistry(parseActivityRoutes('summer-cup=http://themis:8080'));
    const activity = {
      describeCommands: () => Promise.reject(new Error('connection refused')),
    };

    const collected = await collectCommands(registry, activity, silentLogger);
    assert.match(collected.problems[0] as string, /connection refused/);
    assert.ok(collected.commands.some((c) => c.name === 'daily'));
  });
});

describe('這個 repo 不知道活動的規則', () => {
  test('原始碼裡沒有任何活動專屬的字眼', async () => {
    // check-boundaries.mjs 是同一件事的自動化版本;這裡再測一次,
    // 是因為那支腳本只在 pre-commit 跑,而測試在 CI 每次都跑。
    const { globSync, readFileSync } = await import('node:fs');
    const forbidden = /\b(odds|payout|parlay|bracket|seeding|tournamentPhase|matchPhase)\b/i;
    const offenders: string[] = [];
    for (const file of globSync('src/**/*.ts')) {
      if (file.includes('gen')) continue;
      for (const [i, line] of readFileSync(file, 'utf8').split('\n').entries()) {
        if (line.trimStart().startsWith('//')) continue;
        if (forbidden.test(line)) offenders.push(`${file}:${i + 1}`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  test('package.json 裡沒有任何資料庫驅動', async () => {
    const { readFileSync } = await import('node:fs');
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const names = [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ];
    const drivers =
      /^(pg|pg-.*|postgres|mysql.*|better-sqlite3|mongodb|redis|ioredis|drizzle-orm|prisma|@prisma\/.*|knex|typeorm|sequelize)$/;
    assert.deepEqual(
      names.filter((n) => drivers.test(n)),
      [],
      'stentor 不連資料庫',
    );
  });
});
