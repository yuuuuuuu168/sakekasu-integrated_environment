# japanese-guard

応答が英語に切り替わるのを止める Stop フック。ターンの最終回答が英語主体なら、
終了させずに日本語で書き直させる。`.claude/settings.json` の `hooks.Stop` から呼ぶ。

[minorun365/claude-code-japanese-guard](https://github.com/minorun365/claude-code-japanese-guard)
のコミット `930f056` をそのまま同梱している（Apache License 2.0、`LICENSE` と `NOTICE` は上流のもの）。
変えたのはテストが本体を探すパスだけ。上流を取り込み直すときは `japanese-guard.py` を丸ごと差し替える。

上流の README は `~/.claude/` に置く手順だが、クラウドセッションのコンテナは使い捨てで
ホームに置いたものが次のセッションに残らないため、リポジトリに同梱して共有設定から呼ぶ。

## 動かすのに要るもの

Python 3（標準ライブラリだけ）。クラウドVMには入っている。ローカルで Claude Code を
使う場合も `python3` が PATH に要る。無いとフックがエラーを出すが、終了は止めない。

## テスト

```sh
python3 scripts/japanese-guard/test_japanese_guard.py
```

## 閾値

| 環境変数 | 既定 | 意味 |
| --- | --- | --- |
| `JAPANESE_GUARD_MIN_LATIN` | `25` | 英字がこれ未満の本文は判定しない |
| `JAPANESE_GUARD_RATIO` | `3` | 英字の数が日本語の文字数のこの倍を超えたら英語主体とみなす |

## ほかの Stop フックとの関係

別の Stop フック（AI-DLC の `aidlc-continue-workflow.ts` など）を足すと、両方が同時に止めたときに
差し戻しの理由が2つまとめて届く。どちらかが止めた直後の終了では `stop_hook_active` が立つため、
このフックはその1回を検査せずに通す（差し戻しは1ターン1回）。
