---
name: template-sync
description: sakekasu-template の Claude Code 設定（フック・AWS スクリプト・MCP・CLAUDE.md の共通ルール）の更新を、このリポジトリに取り込んで PR にする。「テンプレートから同期して」「テンプレートの変更を取り込んで」と頼まれたとき、または /template-sync で使う。
---

# テンプレートの同期

sakekasu-template の変更を、このリポジトリに取り込む。ファイルの分け方と差分の出し方は
`scripts/template-sync.mjs` の先頭のコメントにある。

## 手順

1. **テンプレートを手元に用意する。** sakekasu-template は非公開なので、セッションに無ければ
   `add_repo`（owner `yuuuuuuu168`、repo `sakekasu-template`、access `read`）で足してから clone する。
   前回の同期以降の差分を出すため、履歴も取っておく。

   ```sh
   git clone https://github.com/yuuuuuuu168/sakekasu-template /tmp/sakekasu-template
   git -C /tmp/sakekasu-template fetch --depth=1000 origin main
   ```

   すでに clone があれば `git -C <dir> fetch origin main && git -C <dir> checkout -q origin/main` で最新にする。

2. **差分を見る。** 取り込む前に一覧だけ出して、何が変わるかを把握する。

   ```sh
   node scripts/template-sync.mjs --template /tmp/sakekasu-template
   ```

   managed も merged も「なし」なら、同期済みなのでユーザーにそう伝えて終わる。

3. **feature ブランチを切って取り込む。**

   ```sh
   node scripts/template-sync.mjs --template /tmp/sakekasu-template --apply
   ```

   managed はテンプレートの中身で上書きされ、`.template-sync.json` の `syncedCommit` が進む。

4. **merged を手で混ぜる。** 出力の diff は「前回の同期以降にテンプレート側で変わった分」なので、
   それをこのリポジトリのファイルに当てる。リポジトリ固有の内容は消さない。
   - `.claude/settings.json`：フックと `permissions.allow` は足し合わせる。同じコマンドを二重に登録しない。
     このリポジトリにしかないフック（AI-DLC など）は残す
   - `CLAUDE.md`：テンプレートの共通ルールの節だけを直す。アプリ固有の節には触れない
   - `scripts/cloud-setup.sh`：`NPM_DIRS` やリポジトリ固有の処理（bun の導入など）は残す
   - `scripts/aws-verify.conf`：アカウントを変えているリポジトリなら、その値を残す
   - 初回（前回の同期が無い）は、テンプレートとの全体の差が出る。取り込み済みの内容との
     言い回しの違いまで無理に合わせなくてよい。意味が変わるところだけ合わせる

   テンプレートのファイルをこのリポジトリで意図的に変えていて、上書きされると困る managed が
   あれば、`.template-sync.json` の `exclude` に足してから `--apply` をやり直す。

5. **確かめる。**

   ```sh
   node --test scripts/deny-aws-writes.test.mjs scripts/template-sync.test.mjs
   python3 scripts/japanese-guard/test_japanese_guard.py
   for f in scripts/*.sh; do bash -n "$f"; done
   node -e "JSON.parse(require('fs').readFileSync('.claude/settings.json','utf8'))"
   ```

   リポジトリの lint やテストがあれば、それも通す。

6. **PR を作って watch する。** PR の本文には、取り込んだテンプレートのコミット（前回 → 今回）、
   上書きした managed、手で混ぜた merged とその判断を書く。

## テンプレートを直したいとき

同期で持ってきたファイル（managed）をこのリポジトリで直すと、次の同期で上書きされる。
全リポジトリに効かせたい直しは、sakekasu-template 側に PR を出してから、各リポジトリで同期する。
