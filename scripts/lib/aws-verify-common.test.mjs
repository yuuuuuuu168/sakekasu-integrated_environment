// aws-verify-common.sh のテスト。`node --test scripts/lib/aws-verify-common.test.mjs` で走る。
// bash で source して関数を呼び、出力を確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const lib = fileURLToPath(new URL('./aws-verify-common.sh', import.meta.url));
// ダミーのアカウント ID。各アプリには「12 桁の数字をリポジトリに書かない」見張りのテストがあるので、
// ファイルには数字を並べず、実行するときに組み立てる
const ACCOUNT = '1'.repeat(12);
const EXTRA_ACCOUNT = '2'.repeat(12);
const OVERRIDE_ACCOUNT = '3'.repeat(12);

const KEYS = ['SSO_START_URL', 'SSO_REGION', 'SSO_ACCOUNT_ID', 'SSO_ROLE_NAME', 'AWS_VERIFY_REGION', 'SSO_EXTRA_PROFILES'];

// 親の環境に同名の変数があっても結果が変わらないよう、キーと CLAUDE_CODE_REMOTE は除いて渡す
function run(script, env = {}) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !KEYS.includes(key) && key !== 'CLAUDE_CODE_REMOTE'));
  return execFileSync('bash', ['-c', `set -euo pipefail; . "$LIB"; ${script}`], {
    encoding: 'utf8',
    env: { ...base, LIB: lib, ...env },
  }).replace(/\n$/, '');
}

function writeConf(lines) {
  const path = join(mkdtempSync(join(tmpdir(), 'conf-')), 'aws-verify.conf');
  writeFileSync(path, `${lines.join('\n')}\n`);
  return path;
}

const conf = () => writeConf([
  '# コメント',
  'SSO_START_URL=https://example.awsapps.com/start',
  'SSO_REGION=ap-northeast-1',
  `SSO_ACCOUNT_ID=${ACCOUNT}`,
  'SSO_ROLE_NAME=AgentVerifyAccess',
  'AWS_VERIFY_REGION=us-east-1',
  `SSO_EXTRA_PROFILES=verify-org:${EXTRA_ACCOUNT}`,
]);

test('is_remote は true と 1 を大文字小文字を問わず受ける', () => {
  for (const value of ['true', 'True', 'TRUE', '1']) {
    assert.equal(run('is_remote && echo yes || echo no', { CLAUDE_CODE_REMOTE: value }), 'yes', value);
  }
  for (const value of ['', 'false', '0', 'yes']) {
    assert.equal(run('is_remote && echo yes || echo no', { CLAUDE_CODE_REMOTE: value }), 'no', value);
  }
  assert.equal(run('is_remote && echo yes || echo no'), 'no', '未設定');
});

test('verify_config_line は aws-verify.conf の値を決まった順に並べる', () => {
  assert.equal(
    run(`load_verify_conf "${conf()}"; verify_config_line`),
    `# verify-config: https://example.awsapps.com/start ap-northeast-1 ${ACCOUNT} AgentVerifyAccess us-east-1 verify-org:${EXTRA_ACCOUNT}`,
  );
});

test('同じ名前の環境変数があればそちらを使い、空の値は conf の値に戻す', () => {
  const line = run(`load_verify_conf "${conf()}"; verify_config_line`, { SSO_ACCOUNT_ID: OVERRIDE_ACCOUNT, SSO_REGION: '' });
  assert.equal(
    line,
    `# verify-config: https://example.awsapps.com/start ap-northeast-1 ${OVERRIDE_ACCOUNT} AgentVerifyAccess us-east-1 verify-org:${EXTRA_ACCOUNT}`,
  );
});

test('SSO_EXTRA_PROFILES だけは、空の環境変数でも conf より優先する', () => {
  const line = run(`load_verify_conf "${conf()}"; verify_config_line`, { SSO_EXTRA_PROFILES: '' });
  assert.equal(line, `# verify-config: https://example.awsapps.com/start ap-northeast-1 ${ACCOUNT} AgentVerifyAccess us-east-1 `);
});

test('同じキーが何度も書かれていれば最後の行を使い、conf が無ければ空にする', () => {
  const path = writeConf(['SSO_ROLE_NAME=First', 'SSO_ROLE_NAME=Last']);
  assert.equal(run(`load_verify_conf "${path}"; echo "$SSO_ROLE_NAME"`), 'Last');
  assert.equal(run('load_verify_conf /nonexistent/aws-verify.conf; echo "[$SSO_START_URL][$SSO_EXTRA_PROFILES]"'), '[][]');
});
