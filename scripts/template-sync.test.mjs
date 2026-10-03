// template-sync.mjs のテスト。`node --test scripts/template-sync.test.mjs` で走る。
// 一時ディレクトリにテンプレート（git リポジトリ）と取り込み先を作って確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { sync } from './template-sync.mjs';

function write(root, path, content, mode) {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  if (mode) execFileSync('chmod', [mode, full]);
}

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
}

function makeTemplate() {
  const dir = mkdtempSync(join(tmpdir(), 'tpl-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@example.com');
  git(dir, 'config', 'user.name', 't');
  write(dir, '.template-sync.json', JSON.stringify({
    template: 'owner/tpl',
    syncedCommit: null,
    managed: ['scripts/hook.sh', 'scripts/other.mjs'],
    merged: ['CLAUDE.md'],
    exclude: [],
  }));
  write(dir, 'scripts/hook.sh', 'echo v1\n', '755');
  write(dir, 'scripts/other.mjs', '// v1\n');
  write(dir, 'CLAUDE.md', '# rules\n- a\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'v1');
  return dir;
}

function makeRepo() {
  return mkdtempSync(join(tmpdir(), 'repo-'));
}

test('初回は managed を追加し、merged は全体を突き合わせる', () => {
  const template = makeTemplate();
  const repo = makeRepo();
  write(repo, 'CLAUDE.md', '# app\n- local rule\n');

  const report = sync({ repo, template, apply: true });

  assert.deepEqual(report.added.sort(), ['scripts/hook.sh', 'scripts/other.mjs']);
  assert.equal(readFileSync(join(repo, 'scripts/hook.sh'), 'utf8'), 'echo v1\n');
  assert.equal(statSync(join(repo, 'scripts/hook.sh')).mode & 0o777, 0o755, '実行権限を保つ');
  assert.equal(report.merged.length, 1);
  assert.match(report.merged[0].diff, /\+- a/);
  assert.equal(readFileSync(join(repo, 'CLAUDE.md'), 'utf8'), '# app\n- local rule\n', 'merged は上書きしない');
  const manifest = JSON.parse(readFileSync(join(repo, '.template-sync.json'), 'utf8'));
  assert.equal(manifest.syncedCommit, git(template, 'rev-parse', 'HEAD'));
});

test('2回目以降の merged は、前回の同期以降のテンプレートの変更だけを出す', () => {
  const template = makeTemplate();
  const repo = makeRepo();
  write(repo, 'CLAUDE.md', '# app\n- local rule\n');
  sync({ repo, template, apply: true });

  write(template, 'CLAUDE.md', '# rules\n- a\n- b\n');
  write(template, 'scripts/hook.sh', 'echo v2\n', '755');
  git(template, 'commit', '-qam', 'v2');

  const report = sync({ repo, template, apply: false });
  assert.deepEqual(report.updated, ['scripts/hook.sh']);
  assert.deepEqual(report.unchanged, ['scripts/other.mjs']);
  assert.equal(report.merged.length, 1);
  assert.match(report.merged[0].diff, /\+- b/);
  assert.doesNotMatch(report.merged[0].diff, /local rule/, 'リポジトリ固有の内容は差分に出さない');
  assert.equal(readFileSync(join(repo, 'scripts/hook.sh'), 'utf8'), 'echo v1\n', '--apply なしでは書き換えない');
});

test('テンプレートに変更が無ければ何も出さない', () => {
  const template = makeTemplate();
  const repo = makeRepo();
  sync({ repo, template, apply: true });

  const report = sync({ repo, template, apply: false });
  assert.equal(report.updated.length + report.added.length, 0);
  assert.equal(report.merged.length, 0);
});

test('exclude に挙げた managed は上書きしない', () => {
  const template = makeTemplate();
  const repo = makeRepo();
  write(repo, '.template-sync.json', JSON.stringify({ template: 'owner/tpl', syncedCommit: null, exclude: ['scripts/other.mjs'] }));
  write(repo, 'scripts/other.mjs', '// local\n');

  const report = sync({ repo, template, apply: true });
  assert.deepEqual(report.excluded, ['scripts/other.mjs']);
  assert.equal(readFileSync(join(repo, 'scripts/other.mjs'), 'utf8'), '// local\n');
  const manifest = JSON.parse(readFileSync(join(repo, '.template-sync.json'), 'utf8'));
  assert.deepEqual(manifest.exclude, ['scripts/other.mjs'], 'exclude は保つ');
});

test('前回の同期のコミットが clone に無ければ、全体の突き合わせに落とす', () => {
  const template = makeTemplate();
  const repo = makeRepo();
  write(repo, '.template-sync.json', JSON.stringify({ template: 'owner/tpl', syncedCommit: '0'.repeat(40), exclude: [] }));
  write(repo, 'CLAUDE.md', '# app\n');

  const report = sync({ repo, template, apply: false });
  assert.equal(report.historyAvailable, false);
  assert.equal(report.merged.length, 1);
  assert.match(report.merged[0].diff, /\+# rules/);
});

test('テンプレートの一覧にあるファイルが無ければ止まる', () => {
  const template = makeTemplate();
  git(template, 'rm', '-q', 'scripts/other.mjs');
  git(template, 'commit', '-qm', 'rm');
  assert.throws(() => sync({ repo: makeRepo(), template, apply: false }), /scripts\/other\.mjs/);
  assert.equal(existsSync(join(template, 'scripts/other.mjs')), false);
});
