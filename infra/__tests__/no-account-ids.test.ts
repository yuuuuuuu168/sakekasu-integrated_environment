import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 公開リポジトリに AWS アカウント ID を書き戻さないための見張り
 * （Issue sakekasu-builder-archive#106）。
 *
 * 本物の ID はここにも書けないので、「許したもの以外の 12 桁の数字があれば落とす」形にする。
 * アカウント ID が要る場所は、Actions では secrets.AWS_ACCOUNT_ID、CDK では
 * CDK_DEFAULT_ACCOUNT から受け取る（README の「アカウント ID」の表）。
 * テストやドキュメントの例には、下の一覧のダミーを使う
 */
const ALLOWED = new Set([
  // テスト・例示用のダミー
  '000000000000',
  '111122223333',
  '123456789012',
]);

/** 依存の lockfile と、同期で入る同梱物は見ない。ハッシュや版番号に 12 桁が混ざる */
const IGNORED = [/(^|\/)package-lock\.json$/, /(^|\/)uv\.lock$/, /^aidlc\//, /^\.claude\//];

const REPO_ROOT = join(import.meta.dirname, '..', '..');

describe('アカウント ID を書き込まない', () => {
  it('追跡しているファイルに、許したもの以外の 12 桁の数字が無い', () => {
    const files = execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' })
      .split('\0')
      .filter((file) => file && !IGNORED.some((pattern) => pattern.test(file)));

    expect(files.length).toBeGreaterThan(0);

    const found: string[] = [];
    for (const file of files) {
      let text: string;
      try {
        text = readFileSync(join(REPO_ROOT, file), 'utf8');
      } catch {
        // 消したが未コミットのファイルなど
        continue;
      }
      for (const match of text.matchAll(/(?<![0-9A-Za-z])[0-9]{12}(?![0-9A-Za-z])/g)) {
        if (!ALLOWED.has(match[0])) {
          // 値そのものは出さない（失敗のログに本物の ID を残さないため）
          found.push(`${file}: ${match[0].slice(0, 4)}********`);
        }
      }
    }

    expect(found, '12 桁の数字がある。アカウント ID なら secrets や環境変数から渡す').toEqual([]);
  });
});
