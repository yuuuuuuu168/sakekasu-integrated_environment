// PreToolUse フックの入口。scripts/deny-aws-writes.sh から呼ばれる。
// stdin に Claude Code のフック入力 JSON を受け取り、拒否するときだけ
// permissionDecision: "deny" を stdout に出す（何も出さなければ通常の権限フロー）。
// 判定は scripts/deny-aws-writes-core.mjs にある。
//
// 判定は常に走らせる。「直接実行されたときだけ動かす」形にすると、実行パスに
// シンボリックリンクが挟まったときに判定ごと素通りする（argv[1] は解決されず、
// import.meta.url は解決済みなので一致しない）。そのため判定本体を別ファイルに分け、
// こちらは常に stdin を読んで判定する入口だけにしてある
import { decide } from './deny-aws-writes-core.mjs';

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let out;
  try {
    out = decide(raw);
  } catch {
    // decide は投げない作りだが、万一投げても終了コード 1 で素通りさせず、拒否側に倒す
    out = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'コマンドの判定に失敗したため許可できません。',
      },
    });
  }
  process.stdout.write(out);
  process.exit(0);
});
