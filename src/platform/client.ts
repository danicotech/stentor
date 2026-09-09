// hestia 平台 API 的 client。
//
// 身分模型(stentor/README.md、hestia 的 activity.proto):
//   - stentor 持 **service token**,不是使用者的 access token
//   - 行為主體用 `X-Acting-User: discord:<snowflake>` 指定,由 hestia 解成 user_id
//
// 這裡不判斷任何權限。「這個人能不能做這件事」是 hestia 的答案,
// 我們只負責把問題連同「是誰在問」送過去。
//
// service token 只會出現在 header 裡,絕不進 log。

import { createClient, type Interceptor } from '@connectrpc/connect';
import type { Client } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';

import { ActivityService } from '../gen/hestia/platform/v1/activity_pb.ts';
import { DailyService } from '../gen/hestia/platform/v1/daily_pb.ts';
import { MeService } from '../gen/hestia/platform/v1/me_pb.ts';
import { NotificationService } from '../gen/hestia/platform/v1/notification_pb.ts';
import { ShopService } from '../gen/hestia/platform/v1/shop_pb.ts';

export const SERVICE_TOKEN_HEADER = 'X-Service-Token';
export const ACTING_USER_HEADER = 'X-Acting-User';

/** `discord:<snowflake>`。這個字串格式是 hestia 那邊解析的契約。 */
export function actingUser(discordUserId: string): string {
  return `discord:${discordUserId}`;
}

/**
 * 每次呼叫要帶的 header。
 *
 * 沒有做成 interceptor,是因為「代表誰」是逐次呼叫都不同的東西,
 * 藏進 transport 只會讓「這次是用誰的身分打的」變得看不出來。
 */
export function actingHeaders(discordUserId: string): Record<string, string> {
  return { [ACTING_USER_HEADER]: actingUser(discordUserId) };
}

export interface PlatformClientConfig {
  readonly baseUrl: string;
  readonly serviceToken: string;
  /** 逾時。Discord 的互動只有 3 秒,超過這個時間再等也沒意義。 */
  readonly timeoutMs?: number;
}

export interface PlatformClients {
  readonly daily: Client<typeof DailyService>;
  readonly me: Client<typeof MeService>;
  readonly shop: Client<typeof ShopService>;
  readonly activity: Client<typeof ActivityService>;
  /** outbox → 頻道的取貨口。只有 consumers/ 會用到,不經過任何互動路徑。 */
  readonly notification: Client<typeof NotificationService>;
}

function serviceTokenInterceptor(token: string): Interceptor {
  return (next) => async (req) => {
    req.header.set(SERVICE_TOKEN_HEADER, token);
    return next(req);
  };
}

export function createPlatformClients(config: PlatformClientConfig): PlatformClients {
  const transport = createConnectTransport({
    baseUrl: config.baseUrl,
    httpVersion: '1.1',
    interceptors: [serviceTokenInterceptor(config.serviceToken)],
    ...(config.timeoutMs !== undefined ? { defaultTimeoutMs: config.timeoutMs } : {}),
  });

  return {
    daily: createClient(DailyService, transport),
    me: createClient(MeService, transport),
    shop: createClient(ShopService, transport),
    activity: createClient(ActivityService, transport),
    notification: createClient(NotificationService, transport),
  };
}
