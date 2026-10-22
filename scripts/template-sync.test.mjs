// template-sync.mjs のテスト。`node --test scripts/template-sync.test.mjs` で走る。
// 一時ディレクトリにテンプレート（git リポジトリ）と取り込み先を作って確かめる。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

test('2回目以降でも、このリポジトリに無い merged は全体を出す', () => {
  const template = makeTemplate();
  const repo = makeRepo();
  write(repo, 'CLAUDE.md', '# app\n');
  sync({ repo, template, apply: true });
  rmSync(join(repo, 'CLAUDE.md'));

  // テンプレート側は前回の同期から変わっていない
  const report = sync({ repo, template, apply: false });
  assert.equal(report.merged.length, 1);
  assert.equal(report.merged[0].exists, false);
  assert.match(report.merged[0].diff, /\+# rules/);
  assert.match(report.merged[0].diff, /\+- a/);
});

test('テンプレートに変更が無ければ何も出さない', () => {
  const template = makeTemplate();
  const repo = makeRepo();
  write(repo, 'CLAUDE.md', '# app\n');
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

// Issue sakekasu-template#38。外したファイルが取り込み先に黙って残らないようにする
test('前回の同期以降にテンプレートの一覧から外れたファイルを報告し、消さない', () => {
  const template = makeTemplate();
  const repo = makeRepo();
  sync({ repo, template, apply: true });

  write(template, '.template-sync.json', JSON.stringify({
    template: 'owner/tpl', syncedCommit: null, managed: ['scripts/hook.sh'], merged: ['CLAUDE.md'], exclude: [],
  }));
  git(template, 'rm', '-q', 'scripts/other.mjs');
  git(template, 'commit', '-qam', 'drop other');

  const report = sync({ repo, template, apply: true });
  assert.deepEqual(report.removed, [{ path: 'scripts/other.mjs', exists: true }]);
  assert.equal(existsSync(join(repo, 'scripts/other.mjs')), true, '--apply でも消さない');

  // 一度報告したら、次の同期（syncedCommit が進んだあと）では出さない
  assert.deepEqual(sync({ repo, template, apply: false }).removed, []);
});

test('managed と merged の間で移っただけのファイルは、外れたと数えない', () => {
  const template = makeTemplate();
  const repo = makeRepo();
  sync({ repo, template, apply: true });

  write(template, '.template-sync.json', JSON.stringify({
    template: 'owner/tpl', syncedCommit: null, managed: ['scripts/hook.sh'], merged: ['CLAUDE.md', 'scripts/other.mjs'], exclude: [],
  }));
  git(template, 'commit', '-qam', 'move other to merged');

  assert.deepEqual(sync({ repo, template, apply: false }).removed, []);
});

test('前回の同期のコミットが無ければ、外れたファイルは判定しない', () => {
  const template = makeTemplate();
  const repo = makeRepo();
  write(repo, '.template-sync.json', JSON.stringify({ template: 'owner/tpl', syncedCommit: '0'.repeat(40), exclude: [] }));
  assert.deepEqual(sync({ repo, template, apply: false }).removed, []);
});

test('merged から managed に移ったファイルは、上書きで消える差分を出す', () => {
  const template = makeTemplate();
  const repo = makeRepo();
  write(repo, 'CLAUDE.md', '# rules\n- a\n- local rule\n');
  sync({ repo, template, apply: true });

  write(template, '.template-sync.json', JSON.stringify({
    template: 'owner/tpl', syncedCommit: null,
    managed: ['scripts/hook.sh', 'scripts/other.mjs', 'CLAUDE.md'], merged: [], exclude: [],
  }));
  git(template, 'commit', '-qam', 'promote');

  const report = sync({ repo, template, apply: true });
  assert.deepEqual(report.promoted.map((entry) => entry.path), ['CLAUDE.md']);
  assert.match(report.promoted[0].diff, /^-- local rule$/m, '消える行が - で出る');
  assert.deepEqual(report.removed, [], '移っただけなので外れたとは数えない');
  assert.equal(readFileSync(join(repo, 'CLAUDE.md'), 'utf8'), '# rules\n- a\n', 'managed になったので上書きする');

  // 次の同期では、もう移ったものとしては出さない
  write(repo, 'CLAUDE.md', '# local again\n');
  assert.deepEqual(sync({ repo, template, apply: false }).promoted, []);
});

test('managed に無い exclude を報告する', () => {
  const template = makeTemplate();
  const repo = makeRepo();
  write(repo, '.template-sync.json', JSON.stringify({
    template: 'owner/tpl', syncedCommit: null, exclude: ['scripts/other.mjs', 'scripts/gone.sh'],
  }));
  write(repo, 'scripts/other.mjs', '// local\n');

  const report = sync({ repo, template, apply: false });
  assert.deepEqual(report.staleExclude, ['scripts/gone.sh']);
  assert.deepEqual(report.excluded, ['scripts/other.mjs']);
});

test('テンプレートの一覧にあるファイルが無ければ止まる', () => {
  const template = makeTemplate();
  git(template, 'rm', '-q', 'scripts/other.mjs');
  git(template, 'commit', '-qm', 'rm');
  assert.throws(() => sync({ repo: makeRepo(), template, apply: false }), /scripts\/other\.mjs/);
  assert.equal(existsSync(join(template, 'scripts/other.mjs')), false);
});

// 直接実行の判定。パスに空白や日本語があるとき、シンボリックリンク経由のときも、黙って終わらずに動く
test('空白と日本語を含むパスや、シンボリックリンク経由でも直接実行できる', () => {
  const template = makeTemplate();
  const dir = mkdtempSync(join(tmpdir(), 'sync dir 同期-'));
  const script = join(dir, 'template-sync.mjs');
  copyFileSync(fileURLToPath(new URL('./template-sync.mjs', import.meta.url)), script);
  const link = join(mkdtempSync(join(tmpdir(), 'link-')), 'template-sync.mjs');
  symlinkSync(script, link);

  for (const path of [script, link]) {
    const result = spawnSync(process.execPath, [path, '--template', template, '--repo', makeRepo()], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /scripts\/hook\.sh/, path);
  }
});

test('--template や --repo の値が無ければ、使い方を出して止まる', () => {
  const script = fileURLToPath(new URL('./template-sync.mjs', import.meta.url));
  for (const args of [['--template'], ['--template', '--apply'], ['--template', '.', '--repo']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, /の値が要る/);
    assert.match(result.stderr, /usage:/);
  }
});
