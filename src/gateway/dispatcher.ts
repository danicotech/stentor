// 互動的主流程:路由 → 呼叫 → 渲染 → 回覆。
//
// 這支檔案不認識任何一個前綴的意義。它只知道:
//   1. registry 說這個前綴歸誰
//   2. 那個「誰」是一個 RenderBackend,吃互動、回 RenderResult
//   3. RenderResult 怎麼變成 Discord 元件是 render/ 的事
//
// 平台自己的 /daily、/shop 也是一個 RenderBackend,跟活動服務走同一條路徑。
// 沒有「如果是平台就…否則就…」——一旦有那個分支,活動就會開始長特例。

import type { RenderResult } from '../gen/hestia/render/v1/render_pb.ts';
import type { Logger } from '../shared/log.ts';
import type { Route, RouteKind, RouteRegistry } from '../routing/registry.ts';
import { route as resolveRoute } from '../routing/router.ts';
import { renderModal, renderView } from '../render/view.ts';
import type { IncomingInteraction, InteractionResponder } from './interaction.ts';
import { errorView, notFoundView, timeoutModalView } from './fallbacks.ts';

export interface RenderBackend {
  handleCommand(route: Route, interaction: IncomingInteraction): Promise<RenderResult>;
  handleComponent(route: Route, interaction: IncomingInteraction): Promise<RenderResult>;
}

export interface DispatcherOptions {
  readonly registry: RouteRegistry;
  readonly backends: Readonly<Record<RouteKind, RenderBackend>>;
  readonly log: Logger;
  /**
   * 在這個時間內拿到後端回應就直接回覆,超過就先 defer。
   *
   * 為什麼要賽跑而不是一律先 defer:Discord 的 modal **必須是第一個回應**,
   * defer 過就再也開不了表單了。一律先 defer 等於永久放棄 modal;
   * 一律不 defer 則後端一慢使用者就看到「互動失敗」。所以兩邊都留。
   *
   * Discord 的硬上限是 3 秒,留 500ms 給網路與序列化。
   */
  readonly deferAfterMs?: number;
}

const DEFAULT_DEFER_AFTER_MS = 2500;

/** 後端呼叫的結果。 */
type Settled =
  | { readonly kind: 'result'; readonly result: RenderResult }
  | { readonly kind: 'error'; readonly error: unknown };

/** dispatch 這一層看到的結果;'handled' 代表逾時分支已經自己回覆完了。 */
type Outcome = Settled | { readonly kind: 'handled' };

export class Dispatcher {
  readonly #registry: RouteRegistry;
  readonly #backends: Readonly<Record<RouteKind, RenderBackend>>;
  readonly #log: Logger;
  readonly #deferAfterMs: number;

  constructor(options: DispatcherOptions) {
    this.#registry = options.registry;
    this.#backends = options.backends;
    this.#log = options.log;
    this.#deferAfterMs = options.deferAfterMs ?? DEFAULT_DEFER_AFTER_MS;
  }

  async dispatch(interaction: IncomingInteraction, responder: InteractionResponder): Promise<void> {
    const log = this.#log.child({
      interaction_id: interaction.id,
      interaction_kind: interaction.kind,
      discord_user_id: interaction.actor.discordUserId,
    });

    const resolution = resolveRoute(this.#registry, interaction);
    if (!resolution.ok) {
      log.warn('互動無法路由', { reason: resolution.reason, detail: resolution.detail });
      // 路由不到的訊息一律私訊:公開頻道不該被「這個按鈕壞了」洗版。
      await this.#respond(responder, notFoundView(resolution.detail), true, log);
      return;
    }

    const { route } = resolution;
    const backend = this.#backends[route.kind];
    const scoped = log.child({ prefix: route.prefix, route_kind: route.kind });

    const call =
      interaction.kind === 'command'
        ? backend.handleCommand(route, interaction)
        : backend.handleComponent(route, interaction);

    const outcome = await this.#race(call, responder, route, interaction, scoped);

    if (outcome.kind === 'handled') return; // 逾時分支已經自己處理完回覆
    if (outcome.kind === 'error') {
      scoped.error('後端呼叫失敗', { error: describe(outcome.error) });
      await this.#respond(responder, errorView(), route.ephemeral, scoped);
      return;
    }

    await this.#deliver(outcome.result, responder, route, scoped);
  }

  /**
   * 賽跑:後端 vs deferAfterMs。
   *
   * 逾時那一邊會先 defer 卡位,然後**繼續等**後端 —— 不是放棄。
   * 使用者看到的是「思考中…」而不是紅色的互動失敗。
   */
  async #race(
    call: Promise<RenderResult>,
    responder: InteractionResponder,
    route: Route,
    interaction: IncomingInteraction,
    log: Logger,
  ): Promise<Outcome> {
    const settled = call.then(
      (result): Settled => ({ kind: 'result', result }),
      (error): Settled => ({ kind: 'error', error }),
    );

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.#deferAfterMs);
      timer.unref?.();
    });

    const first = await Promise.race([settled, timeout]);
    if (timer) clearTimeout(timer);
    if (first !== 'timeout') return first;

    // 後端還在忙:先卡位,再等它。
    const update = interaction.kind !== 'command' && route.updatesSource;
    await responder.defer({ ephemeral: route.ephemeral, update });
    const outcome = await settled;

    if (outcome.kind === 'error') {
      log.error('後端呼叫失敗(已 defer)', { error: describe(outcome.error) });
      await this.#respond(responder, errorView(), route.ephemeral, log);
      return { kind: 'handled' };
    }
    await this.#deliver(outcome.result, responder, route, log);
    return { kind: 'handled' };
  }

  async #deliver(
    result: RenderResult,
    responder: InteractionResponder,
    route: Route,
    log: Logger,
  ): Promise<void> {
    const kind = result.kind;
    if (kind.case === 'modal') {
      if (responder.deferred) {
        // 已經 defer 就開不了表單了(Discord 的規則)。降級成一則提示,
        // 而不是丟例外讓使用者看到「互動失敗」。
        log.warn('後端回了 modal,但互動已 defer,無法開表單', { modal_id: kind.value.id });
        await this.#respond(responder, timeoutModalView(), true, log);
        return;
      }
      const rendered = renderModal(kind.value);
      logWarnings(log, rendered.warnings);
      await responder.openModal(rendered.payload);
      return;
    }

    if (kind.case !== 'view') {
      log.error('RenderResult 沒有內容(view 與 modal 都是空的)');
      await this.#respond(responder, errorView(), route.ephemeral, log);
      return;
    }

    const rendered = renderView(kind.value);
    logWarnings(log, rendered.warnings);
    if (result.updateSource && responder.deferred) {
      await responder.editSource(rendered.payload);
      return;
    }
    await responder.send(rendered.payload);
  }

  async #respond(
    responder: InteractionResponder,
    view: ReturnType<typeof errorView>,
    ephemeral: boolean,
    log: Logger,
  ): Promise<void> {
    const rendered = renderView({ ...view, ephemeral });
    logWarnings(log, rendered.warnings);
    await responder.send(rendered.payload);
  }
}

function logWarnings(log: Logger, warnings: readonly string[]): void {
  for (const warning of warnings) log.warn('渲染警告', { warning });
}

/** 錯誤只留型別與訊息。堆疊留給 log 的 error 欄位,不會進到使用者看到的文字。 */
function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
