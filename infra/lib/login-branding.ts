import { themeColor, themeFromFile, THEME_CSS_PATH, type Theme, type ThemeColors } from './theme';

/** Cognito の色は RRGGBBAA。不透明で使う */
function rgba(colors: ThemeColors, name: string): string {
  return `${themeColor(colors, name)}ff`;
}

/** ライトとダークで同じ形の値を作る */
function bothModes<T>(build: (c: (name: string) => string) => T, theme: Theme) {
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
 * - 色はダークに固定する（colorSchemeMode: DARK）。DYNAMIC だと OS の設定や時刻で白い画面が出るので、
 *   利用者の指定で黒に揃えた。入口のページ（portal.ts）も同じ
 * - 背景の画像（Cognito の既定の模様）は切り、共通テーマの地の色だけにする
 * - フォント・角丸・ロゴの位置などは既定のまま
 */
export function buildLoginBranding(theme: Theme) {
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
        colorSchemeMode: 'DARK',
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
  return buildLoginBranding(themeFromFile(themePath));
}
