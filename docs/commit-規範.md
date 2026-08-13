# Commit 規範

Conventional Commits,四個 repo 同一套。完整版(type 的判準、body 怎麼寫、CI 怎麼擋)在 [hestia/docs/commit-規範.md](https://github.com/danicotech/hestia/blob/main/docs/commit-規範.md),這裡只放格式與本 repo 的 scope。

```text
<type>(<scope>): <subject>

- 為什麼要改
- 有什麼副作用或前提
```

```text
feat(routing): dispatch by custom_id prefix

- the prefix table comes from env, so adding an activity needs no code change
- unknown prefixes get an ephemeral reply instead of letting the interaction time out
```

**訊息一律用英文。** type、scope、subject、body、footer 全部。這份規範本身和程式碼註解仍然是中文。

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

## 怎麼用、怎麼擋

```bash
pnpm install   # husky 的 hook 會在 prepare 時自動掛上
pnpm cz        # 互動式產生訊息。不想用就自己照格式寫,一樣會被檢查
```

| 時機 | 跑什麼 |
|---|---|
| `pre-commit` | `lint-staged`(eslint --fix + prettier)、`lint:custom` |
| `commit-msg` | `commitlint --edit` |

`pnpm cz` 的選項和 commitlint 的規則寫在**同一個檔案**(`commitlint.config.mjs`)—— cz-git 會自己去讀 `scope-enum`,所以加 scope 只要改一個地方。

Go 那兩個 repo 用的是 lefthook + Go 版 commitlint,規則刻意寫成一樣。工具不同不是不一致,是各自用生態裡最順的那個。

**臨時要跳過**:`git commit --no-verify`。但 CI 會再跑一次。

## 這個 repo 特別要注意的

**任何 commit 只要 subject 裡出現活動的規則,就是警訊。** 「加上下注按鈕的階段檢查」這種 subject 代表賽事邏輯跑進 Bot 了 —— 那是活動服務的事,這裡只負責渲染別人給的描述。

## 三條最容易忘的

- subject 用祈使句、小寫開頭、不加句號、72 字元以內(`subject-case` 有開,首字大寫會被擋)
- body 講**為什麼**,不是改了哪些檔案
- **PR 標題也要照這個格式** —— squash merge 之後它就是主線上的 commit message
