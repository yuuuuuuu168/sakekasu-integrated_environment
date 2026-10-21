// pr-watch-reminder.mjs のテスト。依存を増やしたくないので node:test で書く。
// 実行は `node --test scripts/pr-watch-reminder.test.mjs`。
// CI では .github/workflows/claude-hooks.yml が走らせる。
//
// deny-aws-writes.test.mjs と同じく、関数を import せずフックと同じ形で子プロセスに JSON を流す。
// このフックは壊れても異常終了せず、黙って念押しをやめるだけなので、出力の中身まで確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOOK = fileURLToPath(new URL('./pr-watch-reminder.mjs', import.meta.url));

function run(input) {
  const result = spawnSync(process.execPath, [HOOK], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `フックは常に 0 で終わる: ${result.stderr}`);
  return result.stdout;
}

/** 念押しの文面。出ていなければ null */
function reminder(input) {
  const out = run(input);
  if (out === '') return null;
  const parsed = JSON.parse(out);
  assert.equal(parsed.hookSpecificOutput.hookEventName, 'PostToolUse');
  return parsed.hookSpecificOutput.additionalContext;
}

const PR_URL = 'https://github.com/yuuuuuuu168/sakekasu-template/pull/123';
const MCP_INPUT = { owner: 'yuuuuuuu168', repo: 'sakekasu-template', title: 't', head: 'h', base: 'main' };

test('MCP の返り値が構造化された形でも、番号を添えて念押しする', () => {
  const text = reminder({
    tool_name: 'mcp__github__create_pull_request',
    tool_input: MCP_INPUT,
    tool_response: { id: '1', url: PR_URL },
  });
  assert.match(text, /owner=yuuuuuuu168 repo=sakekasu-template pullNumber=123/);
});

test('MCP の返り値が content[].text に JSON 文字列で入っていても拾う', () => {
  const text = reminder({
    tool_name: 'mcp__github__create_pull_request',
    tool_input: MCP_INPUT,
    tool_response: { content: [{ type: 'text', text: JSON.stringify({ number: 45, html_url: PR_URL }) }] },
  });
  // html_url の番号を、入れ子の number より優先する
  assert.match(text, /pullNumber=123/);
});

test('番号が拾えなくても、番号なしの文面で念押しする', () => {
  const text = reminder({
    tool_name: 'mcp__github__create_pull_request',
    tool_input: MCP_INPUT,
    tool_response: { ok: true },
  });
  assert.match(text, /作成した PR の owner \/ repo \/ 番号/);
});

// Issue sakekasu-template#37。gh CLI で作った PR でも watch を促す
test('gh pr create の出力の URL から owner / repo / 番号を拾う', () => {
  const text = reminder({
    tool_name: 'Bash',
    tool_input: { command: 'gh pr create --title "t" --body "b"' },
    tool_response: { stdout: `\nCreating pull request for x into main\n\n${PR_URL}\n`, stderr: '' },
  });
  assert.match(text, /owner=yuuuuuuu168 repo=sakekasu-template pullNumber=123/);
});

test('gh のグローバルオプションや前置きのコマンドがあっても拾う', () => {
  for (const command of [
    'gh -R yuuuuuuu168/sakekasu-template pr create --fill',
    'git push -u origin x && gh pr create --fill',
    'cd repo; gh pr create --fill',
  ]) {
    const text = reminder({ tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: PR_URL } });
    assert.match(text ?? '', /pullNumber=123/, command);
  }
});

test('gh pr create 以外の Bash では何も出さない', () => {
  for (const command of ['git status', 'gh pr view 123', 'gh pr list', 'echo gh pr create', 'npm test']) {
    // gh pr view は PR の URL を出すが、作ったわけではない
    assert.equal(run({ tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: PR_URL } }), '', command);
  }
});

test('gh pr create でも URL が出ていなければ何も出さない（--help や失敗）', () => {
  assert.equal(
    run({ tool_name: 'Bash', tool_input: { command: 'gh pr create --help' }, tool_response: { stdout: 'Usage: gh pr create' } }),
    '',
  );
});

test('壊れた入力でも何も出さずに 0 で終わる', () => {
  assert.equal(run('{ これは JSON ではない'), '');
  assert.equal(run(''), '');
});
