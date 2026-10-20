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

/** CSS の中から `selector { ... }` の中身を取り出し、--sk-* の色だけを表にする */
function readBlock(css: string, selector: string): ThemeColors {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) throw new Error(`共通テーマに ${selector} のブロックが無い`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const colors: ThemeColors = {};
  for (const [, name, value] of css.slice(open + 1, close).matchAll(/--sk-([\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    colors[name] = value.slice(1).toLowerCase();
  }
  return colors;
}

/** 共通テーマのライトとダークの色を読む。ダークはライトの上に上書きする */
export function readTheme(css: string): Theme {
  const light = readBlock(css, ':root');
  const dark = { ...light, ...readBlock(css, ":root[data-theme='dark']") };
  return { light, dark };
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
