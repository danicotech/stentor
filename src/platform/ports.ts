// hestia 還沒有契約的能力。
//
// 這裡的每一個介面都是**暫時的**。它們不是共用型別(那會違反鐵則 6),
// 而是 stentor 內部的接縫:等 hestia 的 proto 補上對應的 RPC,
// 這個檔案就整個刪掉,改成 `createClient(XxxService, transport)`。
//
// 為什麼不先在這裡手刻一份 HTTP 呼叫:猜錯的路徑與欄位名會編譯得過、
// 測試也會綠,然後在整合那天才爆。與其假裝做完了,不如讓它在執行期
// 明確地說「這個還沒開放」,並且在啟動 log 裡列出來。
//
// 缺的 RPC(見回報):
//   MeService.GetPrivacy / UpdatePrivacy  —— /privacy status / optout
//
// `/bind` 曾經在這個清單上,現在不在了:它不需要任何新 RPC。
// Discord OAuth 登入本身就是綁定,`/bind` 只要給一個連結(見 commands/bind.ts)。

export type OptOutLevel = 'none' | 'logging' | 'corpus';

export class PlatformCapabilityUnavailable extends Error {
  constructor(
    readonly capability: string,
    readonly neededRpc: string,
  ) {
    super(`hestia 尚未提供 ${capability}(需要 ${neededRpc})`);
    this.name = 'PlatformCapabilityUnavailable';
  }
}

export interface PrivacyPort {
  get(discordUserId: string): Promise<{ readonly level: OptOutLevel }>;
  set(discordUserId: string, level: OptOutLevel): Promise<{ readonly level: OptOutLevel }>;
}

export interface PlatformPorts {
  readonly privacy: PrivacyPort;
}

const PRIVACY_RPC = 'hestia.platform.v1.MeService.{Get,Update}Privacy';

export const unavailablePorts: PlatformPorts = {
  privacy: {
    get() {
      return Promise.reject(new PlatformCapabilityUnavailable('隱私設定', PRIVACY_RPC));
    },
    set() {
      return Promise.reject(new PlatformCapabilityUnavailable('隱私設定', PRIVACY_RPC));
    },
  },
};

/** 啟動時列出來,免得「怎麼這個指令沒反應」變成一場除錯。 */
export function missingCapabilities(): readonly string[] {
  return [`隱私設定 → ${PRIVACY_RPC}`];
}
