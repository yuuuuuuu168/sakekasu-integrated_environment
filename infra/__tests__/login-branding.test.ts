import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';
import { buildLoginBranding, loginBrandingFromThemeFile, readTheme, THEME_CSS_PATH } from '../lib/login-branding';

const here = path.dirname(url.fileURLToPath(import.meta.url));
const DEFAULTS = JSON.parse(
  fs.readFileSync(path.join(here, 'fixtures/cognito-default-branding-settings.json'), 'utf8'),
) as Record<string, unknown>;

/** 値の入っている場所（a.b.c）を並べる。配列は中身まで見ない */
function leafPaths(value: unknown, prefix = ''): string[] {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([k, v]) => leafPaths(v, prefix ? `${prefix}.${k}` : k));
  }
  return [prefix];
}

function leaves(value: unknown, prefix = ''): Array<[string, unknown]> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
  }
  return [[prefix, value]];
}

const theme = readTheme(fs.readFileSync(THEME_CSS_PATH, 'utf8'));
const branding = buildLoginBranding(theme);

describe('ログイン画面のブランディング', () => {
  it('共通テーマのライトとダークの色を読める', () => {
    expect(theme.light.accent).toBe('1b365d');
    expect(theme.light.bg).toBe('f7f5f0');
    expect(theme.dark.accent).toBe('d4af37');
    expect(theme.dark.bg).toBe('1a1a2e');
  });

  // 形が既定とずれると、Cognito が受け付けないか、足りない項目が意図しない既定に戻る
  it('Cognito の既定と同じ項目をそろえる（足りない項目も余分な項目も無い）', () => {
    expect(leafPaths(branding).sort()).toEqual(leafPaths(DEFAULTS).sort());
  });

  it('色はすべて RRGGBBAA の 8 桁', () => {
    const colors = leaves(branding).filter(([p]) => /color$/i.test(p));
    expect(colors.length).toBeGreaterThan(50);
    for (const [p, v] of colors) {
      expect(v, p).toMatch(/^[0-9a-fA-F]{8}$/);
    }
  });

  it('主ボタンと地の色は共通テーマから取る（ライトは藍、ダークは金）', () => {
    const { primaryButton, pageBackground } = branding.components;
    expect(primaryButton.lightMode.defaults.backgroundColor).toBe('1b365dff');
    expect(primaryButton.darkMode.defaults.backgroundColor).toBe('d4af37ff');
    expect(pageBackground.lightMode.color).toBe('f7f5f0ff');
    expect(pageBackground.darkMode.color).toBe('1a1a2eff');
  });

  it('ライト・ダークは OS に合わせ、既定の背景の模様は出さない', () => {
    expect(branding.categories.global.colorSchemeMode).toBe('DYNAMIC');
    expect(branding.components.pageBackground.image.enabled).toBe(false);
  });

  it('テーマのファイルからも同じものが作れる', () => {
    expect(loginBrandingFromThemeFile()).toEqual(branding);
  });

  it('テーマに色が欠けていたら止まる', () => {
    expect(() => buildLoginBranding({ light: {}, dark: {} })).toThrow(/--sk-/);
  });
});
