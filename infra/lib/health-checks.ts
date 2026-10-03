/**
 * 外形監視（死活監視）の対象。値は cdk.json の context `healthChecks` に書く。
 *
 * このファイルは CDK に依存しない。合成のときに CDK 側で確かめ、同じ関数を
 * 外形監視の Lambda（lambda/health-check）も読み込み時に通す。書き方の誤りは合成で止まり、
 * 環境変数が壊れていれば Lambda の初期化で落ちて「監視の監視」のアラームに出る。
 */
export interface HealthCheckTarget {
  /** 対象の名前。アラーム名とメトリクスの次元に使う（英小文字・数字・ハイフン） */
  name: string;
  /** https の URL。リダイレクトは追いかけ、最後の応答のステータスで判定する */
  url: string;
  /** 既定は GET */
  method?: 'GET' | 'HEAD';
  /** 正常とみなすステータス。既定は [200] */
  expectStatus: number[];
}

const NAME_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
const METHODS = ['GET', 'HEAD'] as const;

function isHttpsUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  // 認証情報を URL に埋めない（環境変数とログに残る）
  return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
}

/**
 * context の値を確かめて型をつける。おかしければ例外で止める。
 * 名前はアラーム名に入るので、重複と使えない文字をここで弾く。
 */
export function parseHealthChecks(value: unknown): HealthCheckTarget[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('context の healthChecks に、外形監視の対象を 1 つ以上書く');
  }
  const names = new Set<string>();
  return value.map((raw, index) => {
    const where = `healthChecks[${index}]`;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new Error(`${where} はオブジェクトで書く`);
    }
    const target = raw as Record<string, unknown>;
    const allowedKeys = new Set(['name', 'url', 'method', 'expectStatus']);
    for (const key of Object.keys(target)) {
      if (!allowedKeys.has(key)) throw new Error(`${where} に知らない項目がある: ${key}`);
    }

    const name = target.name;
    if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
      throw new Error(`${where}.name は英小文字で始まる英小文字・数字・ハイフン（40 文字まで）で書く: ${String(name)}`);
    }
    if (names.has(name)) throw new Error(`${where}.name が重複している: ${name}`);
    names.add(name);

    const url = target.url;
    if (typeof url !== 'string' || !isHttpsUrl(url)) {
      throw new Error(`${where}.url は https の URL にする（認証情報と # を含めない）: ${String(url)}`);
    }

    const method = target.method ?? 'GET';
    if (typeof method !== 'string' || !(METHODS as readonly string[]).includes(method)) {
      throw new Error(`${where}.method は ${METHODS.join(' か ')} にする: ${String(method)}`);
    }

    const expectStatus = target.expectStatus ?? [200];
    if (
      !Array.isArray(expectStatus) ||
      expectStatus.length === 0 ||
      !expectStatus.every((s) => Number.isInteger(s) && (s as number) >= 100 && (s as number) <= 599)
    ) {
      throw new Error(`${where}.expectStatus は HTTP ステータス（100〜599 の整数）の配列にする`);
    }

    return {
      name,
      url,
      method: method as HealthCheckTarget['method'],
      expectStatus: [...(expectStatus as number[])],
    };
  });
}
