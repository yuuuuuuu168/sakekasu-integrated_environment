# unslop-ai-app から取り込んだもの

[minorun365/unslop-ai-app](https://github.com/minorun365/unslop-ai-app)（Apache License 2.0）の
コミット `14c0ec5739af54eb071f5c08d4bea0b24e5501f2` から取り込んだ。ライセンスは同じディレクトリの
`LICENSE`、帰属の表示は `NOTICE` にある。

| 取り込み先 | 元の場所 |
| --- | --- |
| `.claude/skills/app-ui-design/` | `skills/app-ui-design/` |
| `.claude/skills/agent-app-ui/` | `skills/agent-app-ui/` |
| `.claude/skills/mobile-web-check/` | `skills/mobile-web-check/` |
| `scripts/unslop/check-ui.mjs` | `tools/check-ui.mjs` |

元からの変更点:

- `app-ui-design/SKILL.md`：検査スクリプトの場所を `~/.claude/skill-repos/...` から `scripts/unslop/check-ui.mjs` に変えた
- `mobile-web-check/SKILL.md`：Xcode の無いクラウドセッションでは Playwright の iPhone エミュレーションで代わりに見る、という注記を足した

検査はリポジトリのルートから次のように打つ。指摘が 0 件なら終了コード 0。意図して残す行には
`check-ui-ignore` と書くと対象から外れる。

```sh
node scripts/unslop/check-ui.mjs src/
```

sakekasu-template から同期されるファイルなので、直すときはテンプレート側を直す。
