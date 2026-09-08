# stentor

Discord 互動閘道。銅嗓傳令官 —— 只負責喊,不參與決策。

## 最重要的一條規則

**這個 repo 不能知道任何一個活動的規則。** 出現 `if 賽事階段 === ...` 就是寫錯了。

它只做三件事:

1. 收 Discord interaction,依**指令命名空間**路由到對應的活動服務
2. 把活動服務回傳的「要顯示什麼」渲染成 Discord 元件
3. 收 outbox 事件,發到頻道

活動服務回傳的是**描述**,不是 Discord 格式:

```json
{ "title": "阿凱 對 小美",
  "fields": [{"k":"賠率","v":"1.43 / 2.58"}],
  "actions": [{"id":"summer-cup:bet:5:1","label":"押 阿凱","style":"primary"}] }
```

`custom_id` 的前綴就是路由鍵。**加新活動 = 註冊一個前綴 + 對方實作回傳契約,這個 repo 一行都不用改。**

渲染契約住在 `hestia/proto/hestia/render/v1/`,不住這裡 —— 放這裡的話每個新活動都要改 Bot,分 repo 的意義就沒了。

(原規劃寫 `hestia/contracts/render/`「手寫的 spec」,2026-09-08 改成 proto:手寫共用型別違反鐵則 6,而且 Go 與 TS 兩端遲早會漂移。)

## 硬限制

- **絕對沒有 DB 憑證。** Bot 暴露在外部平台,被打下來時不該連著資料庫。
- 不存狀態、不算任何業務結果。
- 呼叫 core 時帶 service token + `X-Acting-User: discord:<id>`。

## Discord API 的現實限制(規劃時務必記得)

| 事項 | 限制 |
|---|---|
| 使用者時區 | **Discord 不提供**。只有網頁端拿得到,Bot 只能讀 DB 存的值 |
| 訊息內容 | 需 `MESSAGE_CONTENT` 特權 intent。只算則數不需要 |
| 上線/離線 | 需 `GUILD_PRESENCES` 特權 intent,且 **Bot 重啟期間的變化會漏掉**,隱身也看不到 → **不可拿來發點數** |
| 語音進出 | `voiceStateUpdate` 可靠,不需特權 intent → **適合發點數與 XP** |

## 技術選型

TypeScript + `discord.js`。**不用 NestJS** —— 薄轉接層套框架只是多背成本。

## 沒有現成 skill

整個生態系沒有像樣的 discord.js skill。這個 repo 的規則要自己寫成 skill。
