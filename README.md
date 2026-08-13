# stentor

Discord 互動閘道:把 Discord 的互動翻成活動服務的 API 呼叫,把活動服務回傳的顯示描述渲染成 Discord 元件。TypeScript + discord.js。

《伊利亞特》裡的傳令官,銅嗓,聲音抵得過五十個人。他只負責喊,不參與決策 —— 這個 repo 的定位就是那樣。

> **現況:骨架階段。** 目錄與職責已經定案,程式碼還沒進來。
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

契約本身住在 [hestia/contracts/render/](https://github.com/danicotech/hestia/tree/main/contracts/render),不住這裡 —— 放這裡的話每個新活動都要來改 Bot 的 repo,分 repo 就沒意義了。

## 目錄

```text
src/
├── gateway/     Discord client、interaction 接收、3 秒逾時與 defer 處理
├── routing/     custom_id / 指令前綴 → 活動服務的對應
├── render/      渲染契約 → discord.js 的 Embed、Button、Modal
├── consumers/   訂閱 outbox 事件,發到頻道
└── config/      前綴註冊表、頻道對應、環境變數
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

綁定流程:網頁登入後產生一次性綁定碼 → 在 Discord 輸入 `/bind <碼>` → hestia 寫入對應。

## 為什麼從第一天就是獨立的 repo

M1 其實只需要兩個 repo,而這是其中一個。理由不是它多大,是**住在一起它一定會壞掉** —— 只要跟賽事程式碼放在同一個 repo,遲早有人(通常是你自己,趕時間的時候)直接 import 賽事型別,那一刻它就再也拆不出來了。

這是目前唯一為了複用而提前付的成本,大約 0.5 人週。

## 開發環境

```bash
pnpm install     # husky 的 hook 會在 prepare 時自動掛上
pnpm lint        # eslint
pnpm lint:custom # 這個 repo 的越界檢查,見下面
pnpm cz          # 互動式產生 commit 訊息
```

| 時機 | 跑什麼 |
|---|---|
| `pre-commit` | `lint-staged`(eslint --fix + prettier)、`lint:custom` |
| `commit-msg` | `commitlint --edit` |

**`scripts/check-boundaries.mjs` 是這個 repo 專屬的。** 它掃 `src/`,只要出現資料庫連線、賠率/串關/賽程樹這類活動概念,或 `phase === ...` 這種階段判斷,就直接失敗。

ESLint 抓不到這種事 —— 那不是語法問題,是知識跑錯層。而這正是這個 repo 唯一會壞掉的方式。

## 預定的環境變數

| 變數 | 用途 |
|---|---|
| `DISCORD_TOKEN` | Bot token |
| `DISCORD_APPLICATION_ID` | 註冊 slash command 用 |
| `DISCORD_DEV_GUILD_ID` | 開發期把指令只註冊到測試伺服器,生效快 |
| `PLATFORM_API_URL` | hestia 的位址 |
| `PLATFORM_SERVICE_TOKEN` | 呼叫平台用的 service token |
| `ACTIVITY_ROUTES` | 前綴註冊表,`<前綴>=<base URL>`,逗號分隔 |
| `LOG_LEVEL` | |

**這份清單裡沒有資料庫連線字串,而且永遠不該有。** 哪天發現需要它,先回頭看是不是有邏輯跑錯層了。
