/**
 * commitlint 的規則,以及 cz-git 的互動式提示設定。
 *
 * 兩件事寫在同一個檔案不是為了省事 —— 是為了讓 `pnpm cz` 問出來的東西,
 * 和 commit-msg hook 檢查的東西,永遠是同一份定義。分兩個檔案遲早會漂。
 * cz-git 會自己去讀下面的 scope-enum,不需要再抄一次。
 *
 * 完整說明見 docs/commit-規範.md。
 */

/** @type {import('cz-git').UserConfig} */
export default {
  extends: ['@commitlint/config-conventional'],

  rules: {
    // 沒有 style —— 格式一律交給 formatter,不該有專門的 commit
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'refactor', 'perf', 'docs', 'test', 'build', 'ci', 'chore', 'revert'],
    ],
    // 跨多層的改動不要硬塞 scope,直接省略
    'scope-enum': [
      2,
      'always',
      [
        'structure',
        'gateway',
        'routing',
        'render',
        'consumers',
        'config',
        'docs',
        'lint',
        'deps',
        'ci',
      ],
    ],
    // 72 才能在 git log --oneline 一行看完
    'header-max-length': [2, 'always', 72],
    'subject-full-stop': [2, 'never', '.'],
    // config-conventional 的預設:只擋首字大寫,句中的 Discord、OpenAPI 照常過
    'body-max-line-length': [2, 'always', 100],
  },

  // 提示文字用英文,是為了不要誘導人用中文寫訊息 —— 訊息一律英文。
  prompt: {
    messages: {
      type: 'Type of change:',
      scope: 'Scope (skip if it spans several layers):',
      subject: 'Short imperative summary. Lower case, no trailing period:\n',
      body: 'Why this change? Bullet points. Use "|" for line breaks:\n',
      breaking: 'What breaks? Use "|" for line breaks:\n',
      footer: 'Issues closed, e.g. #31:\n',
      confirmCommit: 'Commit with this message?',
    },
    types: [
      { value: 'feat', name: 'feat:     a capability users can see' },
      { value: 'fix', name: 'fix:      wrong behaviour corrected' },
      { value: 'refactor', name: 'refactor: internal change, behaviour unchanged' },
      { value: 'perf', name: 'perf:     performance' },
      { value: 'docs', name: 'docs:     documentation only' },
      { value: 'test', name: 'test:     tests only' },
      { value: 'build', name: 'build:    build, dependencies, Dockerfile' },
      { value: 'ci', name: 'ci:       workflows and CI config' },
      { value: 'chore', name: 'chore:    none of the above -- usually means it was not classified' },
      { value: 'revert', name: 'revert:   revert' },
    ],
    useEmoji: false,
    allowCustomScopes: false,
    allowEmptyScopes: true,
    skipQuestions: ['footerPrefix'],
    defaultScope: '',
    upperCaseSubject: false,
    breaklineChar: '|',
  },
};
