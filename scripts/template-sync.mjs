// sakekasu-template の設定を、このリポジトリに取り込む。
// .claude/skills/template-sync/SKILL.md（/template-sync）から呼ばれる。
//
//   node scripts/template-sync.mjs --template <テンプレートの clone>          差分の一覧だけ出す
//   node scripts/template-sync.mjs --template <テンプレートの clone> --apply  取り込む
//
// テンプレート由来のファイルは、テンプレートの .template-sync.json で 2 種類に分けてある。
//
//   managed  テンプレートと同じ中身を保つファイル。--apply でそのまま上書きする
//   merged   リポジトリごとの内容と混ぜるファイル（settings.json、CLAUDE.md など）。
//            上書きはせず、前回の同期以降にテンプレート側で変わった差分を出す。
//            混ぜるのは Claude（人）の仕事
//
// このリポジトリの .template-sync.json には、取り込んだテンプレートのコミット（syncedCommit）と、
// managed のうちこのリポジトリでは上書きしないもの（exclude）だけを持つ。
// ファイルの一覧はテンプレート側が正で、こちらには写さない。
//
// 依存を増やさないため node の標準モジュールと git だけで書く。

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const MANIFEST = '.template-sync.json';

function usage(message) {
  if (message) console.error(message);
  console.error('usage: node scripts/template-sync.mjs --template <dir> [--apply] [--repo <dir>]');
  process.exit(2);
}

function parseArgs(argv) {
  const args = { apply: false, repo: process.cwd(), template: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--template') args.template = argv[++i];
    else if (arg === '--repo') args.repo = argv[++i];
    else usage(`不明な引数: ${arg}`);
  }
  if (!args.template) usage('--template が要る');
  return { ...args, repo: resolve(args.repo), template: resolve(args.template) };
}

function git(dir, ...args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function gitOk(dir, ...args) {
  try {
    git(dir, ...args);
    return true;
  } catch {
    return false;
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`${path} を JSON として読めない: ${error.message}`);
  }
}

function sameContent(a, b) {
  if (!existsSync(a) || !existsSync(b)) return false;
  return readFileSync(a).equals(readFileSync(b));
}

// git diff --no-index は差分があると終了コード 1 を返すので、例外から出力を拾う
function diffFiles(a, b) {
  try {
    return execFileSync('git', ['diff', '--no-index', '--no-color', a, b], { encoding: 'utf8' });
  } catch (error) {
    if (error.status === 1) return error.stdout;
    throw error;
  }
}

function copyManaged(src, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  // 実行権限はテンプレートに合わせる（シェルスクリプトを取り込んで実行できなくなるのを防ぐ）
  chmodSync(dest, statSync(src).mode & 0o777);
}

export function sync({ repo, template, apply }) {
  const templateManifest = readJson(join(template, MANIFEST));
  const localPath = join(repo, MANIFEST);
  const local = existsSync(localPath)
    ? readJson(localPath)
    : { template: templateManifest.template, syncedCommit: null, exclude: [] };
  const exclude = new Set(local.exclude ?? []);

  const head = git(template, 'rev-parse', 'HEAD').trim();
  const synced = local.syncedCommit;
  const historyAvailable = synced ? gitOk(template, 'cat-file', '-e', `${synced}^{commit}`) : false;

  const report = { head, synced, historyAvailable, updated: [], added: [], unchanged: [], excluded: [], merged: [] };

  for (const path of templateManifest.managed) {
    const src = join(template, path);
    const dest = join(repo, path);
    if (!existsSync(src)) throw new Error(`テンプレートに ${path} が無い（.template-sync.json と食い違っている）`);
    if (exclude.has(path)) {
      report.excluded.push(path);
      continue;
    }
    if (sameContent(src, dest)) {
      report.unchanged.push(path);
      continue;
    }
    (existsSync(dest) ? report.updated : report.added).push(path);
    if (apply) copyManaged(src, dest);
  }

  for (const path of templateManifest.merged) {
    const src = join(template, path);
    const dest = join(repo, path);
    const entry = { path, exists: existsSync(dest), diff: '' };
    if (!existsSync(src)) {
      entry.diff = '(テンプレートから消えた。このリポジトリでも要るかを判断する)';
    } else if (historyAvailable) {
      // 前回の同期以降にテンプレート側で変わった分だけ。リポジトリ固有の差は出さない
      entry.diff = git(template, 'diff', '--no-color', `${synced}..HEAD`, '--', path);
    } else {
      // 初回、または履歴が足りないときは全体を突き合わせる
      entry.diff = diffFiles(entry.exists ? dest : '/dev/null', src);
    }
    if (entry.diff.trim()) report.merged.push(entry);
  }

  if (apply) {
    const next = { template: templateManifest.template, syncedCommit: head, exclude: [...exclude] };
    writeFileSync(localPath, `${JSON.stringify(next, null, 2)}\n`);
  }
  return report;
}

function printReport(report, apply) {
  const out = [];
  out.push(`テンプレート: ${report.head.slice(0, 7)}（前回の同期: ${report.synced ? report.synced.slice(0, 7) : 'なし'}）`);
  if (report.synced && !report.historyAvailable) {
    out.push('前回の同期のコミットがテンプレートの clone に無い。merged は全体の突き合わせになる。');
    out.push('差分だけ見たいときは: git -C <テンプレート> fetch --depth=1000 origin main');
  }
  const verb = apply ? '上書きした' : '上書きする';
  out.push('');
  out.push(`## managed（${verb}）`);
  for (const p of report.updated) out.push(`- 更新: ${p}`);
  for (const p of report.added) out.push(`- 追加: ${p}`);
  if (!report.updated.length && !report.added.length) out.push('- なし（すべてテンプレートと同じ）');
  for (const p of report.excluded) out.push(`- 除外（exclude）: ${p}`);
  out.push('');
  out.push('## merged（手で混ぜる）');
  if (!report.merged.length) out.push('- なし');
  for (const entry of report.merged) {
    out.push(`### ${entry.path}${entry.exists ? '' : '（このリポジトリに無い）'}`);
    out.push('```diff');
    out.push(entry.diff.trimEnd());
    out.push('```');
  }
  if (apply) {
    out.push('');
    out.push(`.template-sync.json の syncedCommit を ${report.head.slice(0, 7)} にした。`);
  }
  console.log(out.join('\n'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  try {
    printReport(sync(args), args.apply);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
