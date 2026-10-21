import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));

/** 4 アプリと同じ共通テーマ（sakekasu-template から同期される） */
export const THEME_CSS_PATH = path.join(here, '../../theme/sakekasu-theme.css');

/** 共通テーマの変数（--sk- を外した名前 → 16 進 6 桁の色） */
export type ThemeColors = Record<string, string>;

/** 共通テーマのライトとダークの色 */
export interface Theme {
  light: ThemeColors;
  dark: ThemeColors;
}

/**
 * 共通テーマの :root に書いた --sk-* の宣言を表にする（--sk- を外した名前 → 書いたままの値）。
 * 色はここに light-dark(ライト, ダーク) で 1 か所だけ書いてある（theme/sakekasu-theme.css の冒頭）
 */
function readRoot(css: string): Record<string, string> {
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const start = body.indexOf(':root {');
  if (start === -1) throw new Error('共通テーマに :root のブロックが無い');
  const open = body.indexOf('{', start);
  const declared: Record<string, string> = {};
  for (const [, name, value] of body.slice(open + 1, body.indexOf('}', open)).matchAll(/--sk-([\w-]+)\s*:\s*([^;]+);/g)) {
    declared[name] = value.replace(/\s+/g, ' ').trim();
  }
  return declared;
}

/** light-dark() の引数を、括弧の外のカンマで 2 つに分ける */
function splitLightDark(args: string): [string, string] {
  let depth = 0;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '(') depth++;
    else if (args[i] === ')') depth--;
    else if (args[i] === ',' && depth === 0) return [args.slice(0, i).trim(), args.slice(i + 1).trim()];
  }
  throw new Error(`共通テーマの light-dark() の引数が 2 つではない: ${args}`);
}

/**
 * 値を 16 進 6 桁（# なし）に解く。共通テーマが使う書き方は 16 進 6 桁、var(--sk-*)、light-dark() の 3 つ。
 * 色でない値（フォント）は undefined
 */
function resolve(declared: Record<string, string>, value: string, mode: 'light' | 'dark', seen: string[] = []): string | undefined {
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value.slice(1).toLowerCase();
  const ref = /^var\(--sk-([\w-]+)\)$/.exec(value);
  if (ref) {
    const name = ref[1];
    if (seen.includes(name)) throw new Error(`共通テーマの var() が循環している: --sk-${name}`);
    const target = declared[name];
    if (target === undefined) throw new Error(`共通テーマに --sk-${name} が無い`);
    return resolve(declared, target, mode, [...seen, name]);
  }
  const ld = /^light-dark\((.*)\)$/.exec(value);
  if (ld) return resolve(declared, splitLightDark(ld[1])[mode === 'light' ? 0 : 1], mode, seen);
  return undefined;
}

/** 共通テーマのライトとダークの色を読む */
export function readTheme(css: string): Theme {
  const declared = readRoot(css);
  const palette = (mode: 'light' | 'dark'): ThemeColors => {
    const colors: ThemeColors = {};
    for (const [name, value] of Object.entries(declared)) {
      const hex = resolve(declared, value, mode);
      if (hex) colors[name] = hex;
    }
    return colors;
  };
  return { light: palette('light'), dark: palette('dark') };
}

/** 共通テーマのファイルを読む */
export function themeFromFile(themePath = THEME_CSS_PATH): Theme {
  return readTheme(fs.readFileSync(themePath, 'utf8'));
}

/** 色を 1 つ引く（16 進 6 桁、# なし）。テーマに無ければ合成で止める */
export function themeColor(colors: ThemeColors, name: string): string {
  const hex = colors[name];
  if (!hex) throw new Error(`共通テーマに --sk-${name} が無い`);
  return hex;
}
