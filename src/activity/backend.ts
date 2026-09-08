// 活動服務的 client。
//
// 這支檔案是「加一個活動不用改這個 repo」的實作:它不知道活動叫什麼、
// 有幾個階段、按鈕代表什麼意思。它只做三件事——
//   1. 用 route.baseUrl 建一個 ConnectRPC client(每個前綴一個,建好就快取)
//   2. 把互動原封不動轉成 HandleCommand / HandleComponent
//   3. 把回來的 RenderResult 交出去
//
// custom_id 的內容它完全不解讀:`summer-cup:bet:5:1` 對它來說就是一個字串,
// 只有第一段(路由用)被 router 看過。這是刻意的——一旦這裡開始拆第二段,
// 就等於 stentor 知道了那個活動的語法。

import { createClient, type Client, type Interceptor } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';

import { ActivityInteractionService } from '../gen/hestia/render/v1/render_pb.ts';
import type { RenderResult } from '../gen/hestia/render/v1/render_pb.ts';
import type { RenderBackend } from '../gateway/dispatcher.ts';
import type { IncomingInteraction } from '../gateway/interaction.ts';
import type { Route } from '../routing/registry.ts';
import { SERVICE_TOKEN_HEADER } from '../platform/client.ts';

export type ActivityClient = Client<typeof ActivityInteractionService>;

/** 建 client 的方法可以換掉,測試就是靠這個接縫塞假的進來。 */
export type ActivityClientFactory = (route: Route) => ActivityClient;

export interface ActivityBackendOptions {
  readonly serviceToken: string;
  readonly timeoutMs?: number;
  readonly clientFactory?: ActivityClientFactory;
}

function serviceTokenInterceptor(token: string): Interceptor {
  return (next) => async (req) => {
    req.header.set(SERVICE_TOKEN_HEADER, token);
    return next(req);
  };
}

function actorOf(interaction: IncomingInteraction) {
  return {
    discordUserId: interaction.actor.discordUserId,
    discordGuildId: interaction.actor.guildId,
    discordChannelId: interaction.actor.channelId,
    locale: interaction.actor.locale,
  };
}

export class ActivityBackend implements RenderBackend {
  readonly #cache = new Map<string, ActivityClient>();
  readonly #factory: ActivityClientFactory;

  constructor(options: ActivityBackendOptions) {
    this.#factory =
      options.clientFactory ??
      ((route) => {
        const transport = createConnectTransport({
          baseUrl: route.baseUrl as string,
          httpVersion: '1.1',
          interceptors: [serviceTokenInterceptor(options.serviceToken)],
          ...(options.timeoutMs !== undefined ? { defaultTimeoutMs: options.timeoutMs } : {}),
        });
        return createClient(ActivityInteractionService, transport);
      });
  }

  clientFor(route: Route): ActivityClient {
    const cached = this.#cache.get(route.prefix);
    if (cached) return cached;
    const client = this.#factory(route);
    this.#cache.set(route.prefix, client);
    return client;
  }

  async handleCommand(route: Route, interaction: IncomingInteraction): Promise<RenderResult> {
    const res = await this.clientFor(route).handleCommand({
      command: interaction.commandPath,
      actor: actorOf(interaction),
      options: { ...interaction.options },
      interactionId: interaction.id,
    });
    return res.result ?? emptyResult();
  }

  async handleComponent(route: Route, interaction: IncomingInteraction): Promise<RenderResult> {
    const res = await this.clientFor(route).handleComponent({
      customId: interaction.customId,
      actor: actorOf(interaction),
      values: [...interaction.values],
      inputs: { ...interaction.inputs },
      interactionId: interaction.id,
    });
    return res.result ?? emptyResult();
  }

  /**
   * 問活動服務「你有哪些指令、你收哪些前綴」。
   *
   * 沒有這條的話,加一個活動還是得有人來 stentor 手寫一份 slash command 定義,
   * 「一行都不用改」就是假的。
   */
  async describeCommands(route: Route): Promise<{
    readonly commands: readonly Record<string, unknown>[];
    readonly prefixes: readonly string[];
  }> {
    const res = await this.clientFor(route).describeCommands({});
    return {
      commands: res.commands.map((s) => structToPlain(s) as Record<string, unknown>),
      prefixes: res.prefixes,
    };
  }
}

function emptyResult(): RenderResult {
  // 契約上 result 是必填。回空的話當作服務端有 bug,交給 dispatcher 顯示錯誤。
  return {
    $typeName: 'hestia.render.v1.RenderResult',
    kind: { case: undefined },
    updateSource: false,
  };
}

/** google.protobuf.Struct → 普通 JSON。Discord 的指令 JSON 原封不動轉發。 */
function structToPlain(value: unknown): unknown {
  const struct = value as { fields?: Record<string, unknown> };
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(struct.fields ?? {})) {
    out[key] = valueToPlain(field);
  }
  return out;
}

function valueToPlain(value: unknown): unknown {
  const v = value as { kind?: { case?: string; value?: unknown } };
  const kind = v.kind;
  if (!kind || kind.case === undefined) return null;
  switch (kind.case) {
    case 'nullValue':
      return null;
    case 'structValue':
      return structToPlain(kind.value);
    case 'listValue':
      return ((kind.value as { values?: unknown[] }).values ?? []).map(valueToPlain);
    default:
      return kind.value;
  }
}
