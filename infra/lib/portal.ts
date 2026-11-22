import { ROOT_DOMAIN } from './names';
import { themeColor, themeFromFile, type Theme, type ThemeColors } from './theme';

/** 入口に並べるアプリ。並びはこの順 */
export interface PortalApp {
  /** 画面に出す名前 */
  label: string;
  /**
   * 開く URL（https のみ）。`?sso=1` は「入口で共通ログインを済ませてきた」という合図で、
   * 各アプリは未ログインならサインインのボタンを出さずに共通ログインへ送る（入力なしで戻ってくる）
   */
  url: string;
}

/** ホスト名はどれも cdk.json の apps の callbackUrls にある（apex-redirect-stack.test.ts） */
export const PORTAL_APPS: PortalApp[] = [
  { label: '酒カス', url: `https://sake.${ROOT_DOMAIN}/?sso=1` },
  { label: '家計簿', url: `https://kakeibo.${ROOT_DOMAIN}/?sso=1` },
  { label: 'learning', url: `https://learning.${ROOT_DOMAIN}/?sso=1` },
  { label: 're:Invent', url: `https://reinvent.${ROOT_DOMAIN}/?sso=1` },
];

/** 日本語の字形のフォント。iPhone・Mac はヒラギノ、Windows は游ゴシックかメイリオ、それ以外は Noto や IPA */
const JA_SANS =
  "'Hiragino Sans','Hiragino Kaku Gothic ProN','Yu Gothic','YuGothic','Meiryo','Noto Sans JP','Noto Sans CJK JP','IPAGothic',sans-serif";
/** 見出しの明朝 */
const JA_SERIF = "'Hiragino Mincho ProN','Yu Mincho','YuMincho','Noto Serif JP','IPAMincho',serif";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 使う色だけを、共通テーマと同じ名前（--sk-*）の CSS の変数にする。
 * 関数のコードは 10 KB までなので、テーマの CSS を丸ごとは載せない
 */
function vars(c: ThemeColors): string {
  const names = ['bg', 'surface', 'surface-2', 'border', 'ink', 'muted', 'accent', 'accent-hover', 'accent-ink', 'gold-line', 'focus'];
  return names
    .map((name) => `--sk-${name}:#${themeColor(c, name)}`)
    .join(';');
}

/**
 * 入口の 2 枚のページ。CloudFront Functions が返す（apex-redirect-stack.ts）。
 *
 * - トップ（/）: 和モダンの表紙（青海波と金の罫）と「パスキーでログイン」。ボタンは /apps へ行き、関数が共通ログインへ送る
 * - 一覧（/apps）: 共通ログインから戻ったあとの 4 アプリのボタンとログアウト（/logout）
 *
 * 2 枚は CSS を共有する。関数のコードの大きさを抑えるため、ページは head・css・body に分けて持ち、
 * 関数の中でつなぐ（page()）。色は共通テーマのダークから合成のたびに作る。OS の設定によらず黒に固定する
 * （共通ログインの画面と同じ。利用者の指定）。
 * 外のファイルもスクリプトも使わない（CSP で閉じている）。青海波は CSS のグラデーションで描く。
 */
export interface PortalParts {
  head: string;
  css: string;
  top: string;
  apps: string;
}

function buildPortalParts(theme: Theme, apps = PORTAL_APPS): PortalParts {
  for (const app of apps) {
    if (new URL(app.url).protocol !== 'https:') throw new Error(`入口のリンクは https にする: ${app.url}`);
  }
  // 青海波。半円の重なりを 2 段ずらして並べる。線は金を薄く
  const wave = (bg: string) =>
    `radial-gradient(circle at 50% 100%,${bg} 18%,#${theme.dark['gold-line']}40 19% 23%,${bg} 24% 40%,` +
    `#${theme.dark['gold-line']}40 41% 45%,${bg} 46% 62%,#${theme.dark['gold-line']}40 63% 67%,${bg} 68% 70%,transparent 71%)`;
  // 動きの曲線は 1 本にそろえる（ホバーと押下は 150ms、登場は 400ms）
  const ease = 'cubic-bezier(.22,1,.36,1)';
  const css =
    `:root{color-scheme:dark;${vars(theme.dark)}}` +
    '*{box-sizing:border-box}' +
    `body{margin:0;min-height:100vh;min-height:100svh;background:var(--sk-bg);color:var(--sk-ink);font-family:${JA_SANS};line-height:1.7;font-feature-settings:"palt" 1}` +
    'a{color:inherit;text-decoration:none}' +
    `a:focus-visible{outline:2px solid var(--sk-focus);outline-offset:2px}` +
    // 表紙
    '.cover{min-height:100vh;min-height:100svh;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:32px 24px;position:relative;overflow:hidden}' +
    `.cover:before{content:"";position:absolute;inset:0 0 auto;height:42vh;background:${wave('var(--sk-bg)')} 0 0/48px 24px,${wave('var(--sk-bg)')} 24px 12px/48px 24px;` +
    '-webkit-mask:linear-gradient(#000,transparent);mask:linear-gradient(#000,transparent);z-index:0}' +
    `.cover>*{position:relative;z-index:1;animation:up .4s ${ease} both}` +
    '@keyframes up{from{opacity:0;transform:translateY(8px)}}' +
    '@media (prefers-reduced-motion:reduce){.cover>*{animation:none}}' +
    `h1{font-family:${JA_SERIF};font-weight:600;letter-spacing:.12em;line-height:1.2;margin:0}` +
    '.cover h1{font-size:2.5rem}' +
    '.rule{display:flex;align-items:center;gap:12px;width:min(16rem,70vw);margin:16px 0;color:var(--sk-gold-line);line-height:1}' +
    '.rule:before,.rule:after{content:"";flex:1;border-top:1px solid var(--sk-gold-line)}' +
    '.lead{margin:0 0 40px;color:var(--sk-muted);text-wrap:balance}' +
    `.btn{display:inline-block;padding:16px 40px;border-radius:8px;background:var(--sk-accent);color:var(--sk-accent-ink);font-weight:600;transition:background-color .15s ${ease}}` +
    '.btn:hover{background:var(--sk-accent-hover)}' +
    '.note{margin:12px 0 0;font-size:.875rem;color:var(--sk-muted)}' +
    // 一覧
    '.list{max-width:30rem;margin:0 auto;padding:32px 16px 48px}' +
    'header{display:flex;align-items:center;justify-content:space-between;gap:16px;border-bottom:2px solid var(--sk-gold-line);padding-bottom:8px;margin-bottom:24px}' +
    'header h1{font-size:1.5rem}' +
    '.out{font-size:.875rem;color:var(--sk-muted);border:1px solid var(--sk-border);border-radius:8px;padding:4px 12px}' +
    '.apps{list-style:none;margin:0;padding:0;display:grid;gap:12px}' +
    `.apps a{display:flex;align-items:center;gap:16px;padding:16px 20px;border:1px solid var(--sk-border);border-radius:12px;background:var(--sk-surface);transition:background-color .15s ${ease},border-color .15s ${ease}}` +
    // 行き先を示す右向きの山形（線のアイコン 1 つ分）
    '.apps a:after{content:"";flex:none;margin-left:auto;width:8px;height:8px;border:solid var(--sk-muted);border-width:2px 2px 0 0;transform:rotate(45deg)}' +
    '.apps a:hover,.out:hover{background:var(--sk-surface-2);border-color:var(--sk-accent)}' +
    '.apps b{display:block;font-size:1.125rem;font-weight:600}' +
    'small{display:block;font-size:.875rem;color:var(--sk-muted)}';
  const head =
    '<!doctype html><html lang="ja"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex">' +
    '<meta name="apple-mobile-web-app-title" content="sakekasu">' +
    // ホーム画面のアイコンとマニフェスト。CloudFront Functions が返す（apex-redirect-stack.ts の iconFunctionCode）。
    // iOS は一度アイコンが無いと覚えると、同じ URL を取り直さないことがあるので、URL に版を付ける
    `<link rel="manifest" href="${PORTAL_MANIFEST_PATH}">` +
    `<link rel="apple-touch-icon" sizes="192x192" href="${PORTAL_ICON_URL}">` +
    `<meta name="theme-color" content="#${theme.dark.bg}">` +
    '<title>sakekasu</title>';
  // 表紙の一言は、入口から開けるアプリの名前をそのまま並べる
  const names = apps.map((app) => escapeHtml(app.label)).join('・');
  const top =
    '<main class="cover"><h1>sakekasu</h1>' +
    `<div class="rule" aria-hidden="true">◆</div><p class="lead">${names} の入口</p>` +
    '<a class="btn" href="/apps">パスキーでログイン</a><p class="note">共通ログインの画面へ移動します</p></main>';
  const items = apps
    .map((app) => {
      const host = new URL(app.url).host;
      return (
        `<li><a href="${escapeHtml(app.url)}">` +
        `<span><b>${escapeHtml(app.label)}</b><small>${escapeHtml(host)}</small></span></a></li>`
      );
    })
    .join('');
  const list =
    '<main class="list"><header><h1>sakekasu</h1><a class="out" href="/logout">ログアウト</a></header>' +
    `<ul class="apps">${items}</ul></main>`;
  return { head, css, top, apps: list };
}

/** ホーム画面のアイコンの URL。画像を差し替えたら v= を上げる */
export const PORTAL_ICON_URL = '/apple-touch-icon.png?v=2';
export const PORTAL_MANIFEST_PATH = '/manifest.webmanifest';

/**
 * 入口のマニフェスト。新しい iOS はホーム画面に追加するとき、apple-touch-icon よりマニフェストの
 * アイコンを先に見る（無いと頭文字のアイコンを作る）。display は browser にして、追加したアイコンは
 * ふだんのブラウザで開く（Web アプリとして開くと、ログインの状態がブラウザと別になるため）
 */
function buildPortalManifest(theme: Theme): string {
  return JSON.stringify({
    name: 'sakekasu',
    short_name: 'sakekasu',
    lang: 'ja',
    start_url: '/',
    scope: '/',
    display: 'browser',
    background_color: `#${theme.dark.bg}`,
    theme_color: `#${theme.dark.bg}`,
    icons: [{ src: PORTAL_ICON_URL, sizes: '192x192', type: 'image/png', purpose: 'any' }],
  });
}

export function portalManifestFromThemeFile(): string {
  return buildPortalManifest(themeFromFile());
}

/** 1 枚のページにつなぐ。関数の中の page() と同じつなぎ方（テストと見た目の確認に使う） */
export function renderPage(parts: PortalParts, which: 'top' | 'apps'): string {
  return `${parts.head}<style>${parts.css}</style></head><body>${parts[which]}</body></html>`;
}

export function portalPartsFromThemeFile(): PortalParts {
  return buildPortalParts(themeFromFile());
}
