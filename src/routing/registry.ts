// 前綴註冊表 —— 這個 repo 的核心。
//
// 「加一個新活動 = 註冊一個前綴,stentor 一行都不用改」這句話,
// 具體就是指這張表:平台自己的功能與活動服務登記在同一個結構裡,
// 之後的路由、渲染、錯誤處理全部走同一條路徑,沒有 if 活動 else 平台。

import { isValidPrefix } from './custom-id.ts';

export type RouteKind = 'platform' | 'activity';

export interface Route {
  readonly prefix: string;
  readonly kind: RouteKind;
  /** 活動服務的 base URL;platform 一律 null。 */
  readonly baseUrl: string | null;
  /** 這個前綴的預設回覆是否只有自己看得到。 */
  readonly ephemeral: boolean;
  /** 元件互動預設是否就地更新原訊息(而不是回新訊息)。 */
  readonly updatesSource: boolean;
}

export interface RouteInput {
  readonly prefix: string;
  readonly kind: RouteKind;
  readonly baseUrl?: string | null;
  readonly ephemeral?: boolean;
  readonly updatesSource?: boolean;
}

export class RouteConflictError extends Error {
  constructor(readonly prefix: string) {
    super(`前綴 "${prefix}" 已經被註冊過了`);
    this.name = 'RouteConflictError';
  }
}

export class RouteRegistry {
  readonly #routes = new Map<string, Route>();

  /**
   * 重複註冊直接丟例外,而且是在啟動時丟。
   *
   * 這是刻意的:兩個活動搶同一個前綴的話,後果是使用者按了 A 的按鈕
   * 卻被送到 B 的服務。那種錯誤在線上長得像「偶爾怪怪的」,幾乎查不出來,
   * 所以寧可開不起來。
   */
  register(input: RouteInput): Route {
    if (!isValidPrefix(input.prefix)) {
      throw new Error(`前綴 "${input.prefix}" 不合法`);
    }
    if (this.#routes.has(input.prefix)) {
      throw new RouteConflictError(input.prefix);
    }
    if (input.kind === 'activity' && !input.baseUrl) {
      throw new Error(`活動路由 "${input.prefix}" 缺少 base URL`);
    }
    const route: Route = {
      prefix: input.prefix,
      kind: input.kind,
      baseUrl: input.baseUrl ?? null,
      ephemeral: input.ephemeral ?? true,
      updatesSource: input.updatesSource ?? false,
    };
    this.#routes.set(route.prefix, route);
    return route;
  }

  resolve(prefix: string): Route | undefined {
    return this.#routes.get(prefix);
  }

  has(prefix: string): boolean {
    return this.#routes.has(prefix);
  }

  prefixes(): readonly string[] {
    return [...this.#routes.keys()].sort();
  }

  all(): readonly Route[] {
    return this.prefixes().map((p) => this.#routes.get(p) as Route);
  }

  activityRoutes(): readonly Route[] {
    return this.all().filter((r) => r.kind === 'activity');
  }
}
