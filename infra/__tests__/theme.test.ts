import { describe, expect, it } from 'vitest';
import { readTheme, themeFromFile } from '../lib/theme';

describe('共通テーマの読み取り', () => {
  it('light-dark() と var() を解いて、ライトとダークの 16 進にする', () => {
    const theme = readTheme(`
      :root {
        color-scheme: light dark;
        --sk-font-sans: 'Inter', sans-serif;
        --sk-indigo: #1B365D;
        --sk-bg: light-dark(#f7f5f0, #1a1a2e);
        --sk-accent: light-dark(var(--sk-indigo), #d4af37);
      }
      :root[data-theme='dark'] {
        color-scheme: dark;
      }
    `);
    expect(theme.light).toEqual({ indigo: '1b365d', bg: 'f7f5f0', accent: '1b365d' });
    expect(theme.dark).toEqual({ indigo: '1b365d', bg: '1a1a2e', accent: 'd4af37' });
  });

  it('無い変数を引いていたら止める', () => {
    expect(() => readTheme(':root { --sk-accent: var(--sk-missing); }')).toThrow('--sk-missing');
  });

  it('同期した共通テーマから、ログイン画面と入口のページが使う色が読める', () => {
    const { light, dark } = themeFromFile();
    expect(light.bg).toBe('f7f5f0');
    expect(dark.bg).toBe('1a1a2e');
    expect(light.accent).toBe('1b365d');
    expect(dark.accent).toBe('d4af37');
  });
});
