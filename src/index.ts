// 進入點。
//
// 這裡之後只做三件事,順序就是這個:
//   1. 讀設定(含 ACTIVITY_ROUTES 的前綴註冊表)
//   2. 建 Discord client,把 interaction 交給 gateway/
//   3. 起 outbox consumer,把事件送到頻道
//
// 不要在這裡出現任何活動規則。判準見 scripts/check-boundaries.mjs。

export {};
