import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

const here = path.dirname(url.fileURLToPath(import.meta.url));

/** 4 アプリと同じ共通テーマ（sakekasu-template から同期される） */
export const THEME_CSS_PATH = path.join(here, '../../theme/sakekasu-theme.css');

/** 共通テーマの変数（--sk- を外した名前 → 16 進 6 桁の色） */
export type ThemeColors = Record<string, string>;

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
export function readTheme(css: string): { light: ThemeColors; dark: ThemeColors } {
  const light = readBlock(css, ':root');
  const dark = { ...light, ...readBlock(css, ":root[data-theme='dark']") };
  return { light, dark };
}

/** Cognito の色は RRGGBBAA。不透明で使う */
function rgba(colors: ThemeColors, name: string): string {
  const hex = colors[name];
  if (!hex) throw new Error(`共通テーマに --sk-${name} が無い`);
  return `${hex}ff`;
}

/** ライトとダークで同じ形の値を作る */
function bothModes<T>(build: (c: (name: string) => string) => T, theme: { light: ThemeColors; dark: ThemeColors }) {
  return {
    lightMode: build((name) => rgba(theme.light, name)),
    darkMode: build((name) => rgba(theme.dark, name)),
  };
}

/**
 * マネージドログイン（共通ログインの画面）のブランディング設定を、共通テーマの色から組み立てる。
 *
 * 形は Cognito の既定値（describe-managed-login-branding --return-merged-resources で取った
 * __tests__/fixtures/cognito-default-branding-settings.json）と同じで、色だけを差し替える。
 * 既定と同じ形であることはテストで確かめている。
 *
 * - ライト・ダークは利用者の OS に合わせる（colorSchemeMode: DYNAMIC）。4 アプリの画面と同じ
 * - 背景の画像（Cognito の既定の模様）は切り、共通テーマの地の色だけにする
 * - フォント・角丸・ロゴの位置などは既定のまま
 */
export function buildLoginBranding(theme: { light: ThemeColors; dark: ThemeColors }) {
  const m = <T>(build: (c: (name: string) => string) => T) => bothModes(build, theme);

  return {
    components: {
      secondaryButton: m((c) => ({
        hover: { backgroundColor: c('accent-weak'), borderColor: c('accent-hover'), textColor: c('accent-hover') },
        defaults: { backgroundColor: c('surface'), borderColor: c('accent'), textColor: c('accent') },
        active: { backgroundColor: c('accent-weak'), borderColor: c('accent-hover'), textColor: c('accent-hover') },
      })),
      form: {
        ...m((c) => ({ backgroundColor: c('surface'), borderColor: c('gold-line') })),
        borderRadius: 8.0,
        backgroundImage: { enabled: false },
        logo: { location: 'CENTER', position: 'TOP', enabled: false, formInclusion: 'IN' },
      },
      alert: {
        ...m((c) => ({ error: { backgroundColor: c('surface-2'), borderColor: c('danger') } })),
        borderRadius: 12.0,
      },
      favicon: { enabledTypes: ['ICO', 'SVG'] },
      pageBackground: {
        image: { enabled: false },
        ...m((c) => ({ color: c('bg') })),
      },
      pageText: m((c) => ({ bodyColor: c('ink-2'), headingColor: c('ink'), descriptionColor: c('muted') })),
      phoneNumberSelector: { displayType: 'TEXT' },
      primaryButton: m((c) => ({
        hover: { backgroundColor: c('accent-hover'), textColor: c('accent-ink') },
        defaults: { backgroundColor: c('accent'), textColor: c('accent-ink') },
        active: { backgroundColor: c('accent-hover'), textColor: c('accent-ink') },
        disabled: { backgroundColor: c('surface-2'), borderColor: c('border') },
      })),
      pageFooter: {
        ...m((c) => ({ borderColor: c('border'), background: { color: c('surface') } })),
        backgroundImage: { enabled: false },
        logo: { location: 'START', enabled: false },
      },
      pageHeader: {
        ...m((c) => ({ borderColor: c('border'), background: { color: c('surface') } })),
        backgroundImage: { enabled: false },
        logo: { location: 'START', enabled: false },
      },
      idpButton: {
        standard: m((c) => ({
          hover: { backgroundColor: c('accent-weak'), borderColor: c('accent-hover'), textColor: c('accent-hover') },
          defaults: { backgroundColor: c('surface'), borderColor: c('ink-2'), textColor: c('ink-2') },
          active: { backgroundColor: c('accent-weak'), borderColor: c('accent-hover'), textColor: c('accent-hover') },
        })),
      },
    },
    componentClasses: {
      dropDown: {
        ...m((c) => ({
          hover: { itemBackgroundColor: c('surface-2'), itemBorderColor: c('border'), itemTextColor: c('ink') },
          defaults: { itemBackgroundColor: c('surface') },
          match: { itemBackgroundColor: c('accent-weak'), itemTextColor: c('accent') },
        })),
        borderRadius: 8.0,
      },
      input: {
        ...m((c) => ({
          defaults: { backgroundColor: c('surface'), borderColor: c('border') },
          placeholderColor: c('muted'),
        })),
        borderRadius: 8.0,
      },
      inputDescription: m((c) => ({ textColor: c('muted') })),
      buttons: { borderRadius: 8.0 },
      optionControls: m((c) => ({
        defaults: { backgroundColor: c('surface'), borderColor: c('border') },
        selected: { backgroundColor: c('accent'), foregroundColor: c('accent-ink') },
      })),
      statusIndicator: m((c) => ({
        success: { backgroundColor: c('surface-2'), borderColor: c('success'), indicatorColor: c('success') },
        // 既定でも半透明のグレー。テーマに相当する色が無いのでそのまま
        pending: { indicatorColor: 'AAAAAAAA' },
        warning: { backgroundColor: c('surface-2'), borderColor: c('warning'), indicatorColor: c('warning') },
        error: { backgroundColor: c('surface-2'), borderColor: c('danger'), indicatorColor: c('danger') },
      })),
      divider: m((c) => ({ borderColor: c('border') })),
      idpButtons: { icons: { enabled: true } },
      focusState: m((c) => ({ borderColor: c('focus') })),
      inputLabel: m((c) => ({ textColor: c('ink') })),
      link: m((c) => ({
        hover: { textColor: c('accent-hover') },
        defaults: { textColor: c('accent') },
      })),
    },
    categories: {
      form: {
        sessionTimerDisplay: 'NONE',
        instructions: { enabled: false },
        languageSelector: { enabled: false },
        displayGraphics: true,
        location: { horizontal: 'CENTER', vertical: 'CENTER' },
      },
      auth: {
        federation: { interfaceStyle: 'BUTTON_LIST', order: [] },
        authMethodOrder: [
          [
            { display: 'BUTTON', type: 'FEDERATED' },
            { display: 'INPUT', type: 'USERNAME_PASSWORD' },
          ],
        ],
      },
      global: {
        colorSchemeMode: 'DYNAMIC',
        pageFooter: { enabled: false },
        pageHeader: { enabled: false },
        spacingDensity: 'REGULAR',
      },
      signUp: { acceptanceElements: [{ enforcement: 'NONE', textKey: 'en' }] },
    },
  };
}

/** 共通テーマのファイルを読んで、ブランディング設定を作る */
export function loginBrandingFromThemeFile(themePath = THEME_CSS_PATH) {
  return buildLoginBranding(readTheme(fs.readFileSync(themePath, 'utf8')));
}
