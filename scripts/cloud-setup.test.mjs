// cloud-setup.sh のテスト。`node --test scripts/cloud-setup.test.mjs` で走る。
// 一時ディレクトリにリポジトリの形を作り、設定ファイルと cloud-setup.d の扱いを確かめる。
// npm ci は package-lock.json のあるディレクトリでしか走らないので、ここでは走らせない。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));

function makeRepo({ conf, extras = {} } = {}) {
  const repo = mkdtempSync(join(tmpdir(), 'cloud-setup-'));
  mkdirSync(join(repo, 'scripts/lib'), { recursive: true });
  copyFileSync(here('./cloud-setup.sh'), join(repo, 'scripts/cloud-setup.sh'));
  copyFileSync(here('./lib/aws-verify-common.sh'), join(repo, 'scripts/lib/aws-verify-common.sh'));
  if (conf !== undefined) writeFileSync(join(repo, 'scripts/cloud-setup.conf'), conf);
  for (const [name, body] of Object.entries(extras)) {
    mkdirSync(join(repo, 'scripts/cloud-setup.d'), { recursive: true });
    writeFileSync(join(repo, 'scripts/cloud-setup.d', name), body);
  }
  return repo;
}

// bash -x の出力から install_if_needed に渡ったディレクトリを拾う
function run(repo, env = { CLAUDE_CODE_REMOTE: '1' }) {
  const { CLAUDE_CODE_REMOTE, SAKEKASU_AWS_LOGIN, ...base } = process.env;
  const result = spawnSync('bash', ['-x', join(repo, 'scripts/cloud-setup.sh')], { encoding: 'utf8', env: { ...base, ...env } });
  const dirs = [...result.stderr.matchAll(/^\++ install_if_needed (.+)$/gm)].map((m) => m[1]);
  return { ...result, dirs };
}

test('ローカルでは何もしない', () => {
  const result = run(makeRepo(), {});
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('設定ファイルが無ければ . と infra を見て、運用方針を出す', () => {
  const result = run(makeRepo());
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.dirs, ['.', 'infra']);
  assert.match(result.stdout, /\[session policy\]/);
});

test('cloud-setup.conf の NPM_DIRS を空白で分けて使う', () => {
  const result = run(makeRepo({ conf: '# コメント\nNPM_DIRS=. app/cli app/infra\n' }));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.dirs, ['.', 'app/cli', 'app/infra']);
});

test('cloud-setup.d の *.sh を名前順に走らせ、失敗しても残りと運用方針を続ける', () => {
  const repo = makeRepo({
    extras: { '20-second.sh': 'echo second\n', '10-first.sh': 'echo first; exit 3\n', 'notes.txt': 'echo ignored\n' },
  });
  const result = run(repo);
  assert.equal(result.status, 0, result.stderr);
  const out = result.stdout;
  assert.ok(out.indexOf('first') < out.indexOf('second'), '名前順');
  assert.match(out, /10-first\.sh が失敗した（終了コード 3）/);
  assert.doesNotMatch(out, /ignored/, '*.sh だけを走らせる');
  assert.ok(out.indexOf('second') < out.indexOf('[session policy]'), '運用方針はそのあと');
});
