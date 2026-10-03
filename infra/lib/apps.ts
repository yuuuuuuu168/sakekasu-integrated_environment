/**
 * 共通ログインを使うアプリ。1 つにつき Cognito のアプリクライアントを 1 つ作る。
 *
 * 値は cdk.json の context `apps` に書く。ログイン後に戻る URL（callbackUrls）と
 * ログアウト後に戻る URL（logoutUrls）は、Cognito に登録したものと完全に一致しないと
 * ログイン画面がエラーになる（末尾の / の有無も区別される）。
 */
export interface AppClientConfig {
  /** アプリの名前。クライアント名と出力名に使う（英小文字・数字・ハイフン） */
  name: string;
  callbackUrls: string[];
  logoutUrls: string[];
}

const NAME_PATTERN = /^[a-z][a-z0-9-]{1,30}$/;

/** https か、手元で動かすときの http://localhost だけを通す */
function isAllowedUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && url.hostname === 'localhost';
}

/**
 * context の値を確かめて型をつける。おかしければ合成を止める。
 * 戻り先の URL を書き間違えると、ログインの戻り先として任意の場所を許すことになりかねないため、
 * 形式は厳しめに見る。
 */
export function parseApps(value: unknown): AppClientConfig[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('context の apps に、共通ログインを使うアプリを 1 つ以上書く');
  }
  const names = new Set<string>();
  return value.map((raw, index) => {
    const app = raw as Partial<AppClientConfig>;
    const where = `apps[${index}]`;
    if (typeof app.name !== 'string' || !NAME_PATTERN.test(app.name)) {
      throw new Error(`${where}.name は英小文字・数字・ハイフンで書く: ${String(app.name)}`);
    }
    if (names.has(app.name)) throw new Error(`${where}.name が重複している: ${app.name}`);
    names.add(app.name);
    for (const key of ['callbackUrls', 'logoutUrls'] as const) {
      const urls = app[key];
      if (!Array.isArray(urls) || urls.length === 0) {
        throw new Error(`${where}.${key} に URL を 1 つ以上書く`);
      }
      for (const url of urls) {
        if (typeof url !== 'string' || !isAllowedUrl(url)) {
          throw new Error(`${where}.${key} の URL は https か http://localhost にする: ${String(url)}`);
        }
      }
    }
    return { name: app.name, callbackUrls: [...app.callbackUrls!], logoutUrls: [...app.logoutUrls!] };
  });
}
