# stentor

Discord 互動閘道:把 Discord 的互動翻成活動服務的 API 呼叫,把活動服務回傳的顯示描述渲染成 Discord 元件。TypeScript + discord.js。

《伊利亞特》裡的傳令官,銅嗓,聲音抵得過五十個人。他只負責喊,不參與決策 —— 這個 repo 的定位就是那樣。

> **現況:M2 實作中。** 路由、渲染、平台指令、活動記錄、公告消費端都在了;
> `/bind` 與 `/privacy optout` 等 hestia 補上對應的 RPC(見「還缺什麼」)。
> 設計決策的來源是 [hestia/docs/架構規劃書.md](https://github.com/danicotech/hestia/blob/main/docs/架構規劃書.md)。

## 這裡最重要的一條規則

**stentor 不知道任何一個活動的規則。**

程式碼裡不該出現 `if (phase === 'BETTING')`、不該有賠率、不該有賽程樹、不該知道什麼叫串關。一旦出現一行這種東西,它就從「通用閘道」退化成「這次比賽的 Bot」,下個活動就得改它。

它只做三件事:

1. 收 Discord interaction,依指令命名空間路由到對應的活動服務
2. 把活動服務回傳的顯示描述渲染成 Discord 元件
3. 收 outbox 事件,發到頻道

## 路由怎麼運作

活動服務回傳的是**描述**,不是 Discord 格式:

```json
{ "title": "阿凱 對 小美",
  "fields": [{"k":"賠率","v":"1.43 / 2.58"},{"k":"票數","v":"18"}],
  "actions": [{"id":"summer-cup:bet:5:1","label":"押 阿凱","style":"primary"}] }
```

`custom_id` 的第一段就是路由鍵。加一個新活動 = 在設定裡註冊一個前綴、指向它的 base URL,**這個 repo 一行都不用改**。

契約本身住在 hestia 的 **`proto/hestia/render/v1/render.proto`**,不住這裡 —— 放這裡的話每個新活動都要來改 Bot 的 repo,分 repo 就沒意義了。

原本規劃寫的是 `hestia/contracts/render/`(手寫的共用型別),改成 proto 是因為專案鐵則 6:**契約自動生成,禁止手寫共用型別**。`src/gen/` 底下的東西全部由 `pnpm gen` 從 hestia 的 proto 產出,進版控但不要手改。

### 加一個活動要做什麼

1. 活動服務實作 `hestia.render.v1.ActivityInteractionService` 的三個 rpc:
   - `DescribeCommands` —— 交出自己的 slash 指令定義與收的前綴
   - `HandleCommand` / `HandleComponent` —— 回一個 `RenderResult`
2. 在 `ACTIVITY_ROUTES` 加一行:`<前綴>=<base URL>`
3. 跑 `pnpm commands:register`

**這個 repo 一行都不用改。** 這件事有測試盯著:`tests/add-activity.test.ts`。

## 目錄

```text
src/
├── gen/         buf 從 hestia 的 proto 生成的契約(進版控,不要手改)
├── gateway/     Discord client、互動抽象、3 秒逾時與 defer 處理
├── routing/     custom_id / 指令前綴 → 目的地的對應
├── render/      渲染契約 → Discord 的 Embed、Button、Select、Modal
├── platform/    hestia 的 client;以及 hestia 還沒提供的能力的接縫
├── activity/    活動服務的 client(依前綴建、快取)
├── commands/    平台自己的指令與它們的 Discord 定義
├── activitylog/ voiceStateUpdate / 訊息 / 表情 → hestia 的活動記錄 API
├── consumers/   outbox 事件 → 頻道推播
├── announce/    規則頻道的資料告知文案
├── config/      環境變數、前綴註冊表、頻道對應
├── shared/      logger
└── cli/         pnpm commands:register
tests/
deploy/
docs/
```

## 它不做的事

| 不做 | 為什麼 |
|---|---|
| 連資料庫 | 容器裡不該有連線字串。Bot 暴露在外部平台,它被打下來時不該連著資料庫 |
| 存任何狀態 | 狀態的權威在 hestia 和活動服務 |
| 算任何業務結果 | 賠率、餘額、能不能下注,一律問後端 |
| 判斷權限 | 帶 `X-Acting-User: discord:<id>`,由 hestia 決定這個人能做什麼 |

## 身分

持 service token 呼叫平台 API,呼叫時帶 `X-Acting-User: discord:<id>` 代理使用者身分,hestia 用 `users.discord_user_id` 對應到帳號。

綁定流程:**沒有綁定碼。** 用 Discord OAuth 登入網頁的那一刻就完成綁定 —— hestia 當場拿到 Discord user id 並建好 `identities`。再要一組碼,是重新證明 OAuth 已經證明過的事;而且 OAuth 的 state 綁在 HttpOnly cookie 上,由 Bot 代開的登入連結沒有對應的 cookie,回呼一定失敗。

所以 `/bind` 只做一件事:回一則 ephemeral 訊息,附上 `WEB_BASE_URL` 的登入頁連結。使用者未綁定時,hestia 的代打會回 `FailedPrecondition`,那時顯示的是同一則指引。

## 為什麼從第一天就是獨立的 repo

M1 其實只需要兩個 repo,而這是其中一個。理由不是它多大,是**住在一起它一定會壞掉** —— 只要跟賽事程式碼放在同一個 repo,遲早有人(通常是你自己,趕時間的時候)直接 import 賽事型別,那一刻它就再也拆不出來了。

這是目前唯一為了複用而提前付的成本,大約 0.5 人週。

## 開發環境

```bash
pnpm install            # husky 的 hook 會在 prepare 時自動掛上
pnpm gen                # 從 ../hestia/proto 生成 src/gen(改完 proto 一定要跑)
pnpm typecheck          # tsc --noEmit(含 tests/)
pnpm lint               # eslint
pnpm lint:custom        # 這個 repo 的越界檢查,見下面
pnpm test               # node:test,不需要 Discord token 也不需要網路
pnpm commands:register  # 把 slash 指令註冊到 Discord
pnpm cz                 # 互動式產生 commit 訊息
```

Node 22.18+ 內建型別剝離,所以 `.ts` 直接跑。`--experimental-transform-types`
是必要的:生成的契約碼有 TS `enum`,strip-only 模式不吃。

`pnpm gen` 的輸入是相對路徑 `../hestia/proto` —— 四個 repo 是兄弟目錄。
生成結果進版控,所以 CI 與部署不必先簽出 hestia。

### 測試怎麼寫

Discord 的互動物件在 `src/gateway/interaction.ts` 被抽象成純資料介面,
`adapter.ts` 是唯一認識 discord.js 的地方。所以測試造一個互動 = 造一個物件,
驗回覆 = 看假 responder 收到什麼。**沒有 token、沒有網路、沒有 Discord。**

| 時機 | 跑什麼 |
|---|---|
| `pre-commit` | `lint-staged`(eslint --fix + prettier)、`lint:custom` |
| `commit-msg` | `commitlint --edit` |

**`scripts/check-boundaries.mjs` 是這個 repo 專屬的。** 它掃 `src/`,只要出現資料庫連線、賠率/串關/賽程樹這類活動概念,或 `phase === ...` 這種階段判斷,就直接失敗。

ESLint 抓不到這種事 —— 那不是語法問題,是知識跑錯層。而這正是這個 repo 唯一會壞掉的方式。

唯一的例外是行首標了 `// boundary-guard: <理由>` 的下一行,用在「這一行本身就是在執行這條規則」的地方(目前只有一處:設定載入器檢查環境裡有沒有資料庫連線字串)。

## 還缺什麼(等 hestia)

| 功能 | 缺的契約 | 目前行為 |
|---|---|---|
| `/privacy optout` / `status` | `MeService.GetPrivacy` / `UpdatePrivacy` | 回「這個功能還沒開放」,並說出缺哪支 RPC |
| outbox → 頻道 | `NotificationService.PullAnnouncements` / `AckAnnouncements` | 消費端與去重都寫好了,來源是記憶體版的假來源 |

`/daily`、`/balance`、`/shop`、`/bind` 都已經可以用:hestia 的代打白名單(service token + `X-Acting-User` 可呼叫 8 支使用者 RPC)已經落地。

## 預定的環境變數

| 變數 | 用途 |
|---|---|
| `DISCORD_TOKEN` | Bot token |
| `DISCORD_APPLICATION_ID` | 註冊 slash command 用 |
| `DISCORD_DEV_GUILD_ID` | 開發期把指令只註冊到測試伺服器,生效快 |
| `PLATFORM_API_URL` | hestia 的位址 |
| `PLATFORM_SERVICE_TOKEN` | 呼叫平台用的 service token |
| `WEB_BASE_URL` | 網頁前端位址。`/bind` 的登入連結指向它的 `/login` |
| `ACTIVITY_ROUTES` | 前綴註冊表,`<前綴>=<base URL>[;public][;update]`,逗號分隔 |
| `CHANNEL_MAP` | 邏輯頻道名 → channel id,`<名字>=<id>`,逗號分隔 |
| `DISCORD_MESSAGE_CONTENT_INTENT` | 是否開特權 intent。關掉仍然記則數,只是沒有內容 |
| `MESSAGE_BATCH_SIZE` / `MESSAGE_FLUSH_MS` | 訊息批次送出的門檻 |
| `BACKEND_TIMEOUT_MS` | 呼叫後端的逾時 |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error` |

完整說明見 [.env.example](.env.example)。

**這份清單裡沒有資料庫連線字串,而且永遠不該有。** 哪天發現需要它,先回頭看是不是有邏輯跑錯層了。
