# Commit 規範

Conventional Commits,四個 repo 同一套。完整版(type 的判準、body 怎麼寫、CI 怎麼擋)在 [hestia/docs/commit-規範.md](https://github.com/danicotech/hestia/blob/main/docs/commit-規範.md),這裡只放格式與本 repo 的 scope。

```text
<type>(<scope>): <subject>

- 為什麼要改
- 有什麼副作用或前提
```

```text
feat(routing): 依 custom_id 前綴分派到活動服務

- 前綴表從環境變數讀,加活動不用改程式碼
- 找不到前綴時回一則 ephemeral 訊息,不要讓互動逾時
```

**冒號前面沒有空格。** `feat(routing) : xxx` 會被 commitlint 擋下來。

## type

`feat` / `fix` / `refactor` / `perf` / `docs` / `test` / `build` / `ci` / `chore` / `revert`

## scope

| scope | 範圍 |
|---|---|
| `gateway` | Discord client、interaction 接收、defer 與逾時 |
| `routing` | 前綴表、分派到活動服務 |
| `render` | 顯示描述 → discord.js 元件 |
| `consumers` | outbox 事件 → 頻道 |
| `config` | 設定與前綴註冊 |
| `deps` | 相依升級 |
| `ci` | workflow |

## 這個 repo 特別要注意的

**任何 commit 只要 subject 裡出現活動的規則,就是警訊。** 「加上下注按鈕的階段檢查」這種 subject 代表賽事邏輯跑進 Bot 了 —— 那是活動服務的事,這裡只負責渲染別人給的描述。

## 三條最容易忘的

- subject 用祈使句、不加句號、72 字元以內
- body 講**為什麼**,不是改了哪些檔案
- **PR 標題也要照這個格式** —— squash merge 之後它就是主線上的 commit message
