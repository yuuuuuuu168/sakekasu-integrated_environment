import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const ssmClient = new SSMClient({});

/**
 * SSM から読んだ値を使い回す時間。
 *
 * Webhook の URL や署名鍵を入れ替えたとき、温まった実行環境が古い値を使い続けると
 * 送信だけが静かに落ちる。呼び出しのたびに取りに行くほどでもないので、
 * 短い期限を付けて放っておいても入れ替わるようにする
 */
export const PARAMETER_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * SecureString のパラメータを読む関数を作る。読んだ値は期限付きで使い回す。
 *
 * parse で値を検証・変換し、その結果を使い回す。parse が投げた例外はそのまま呼び出し元に返し、
 * キャッシュには残さない。値そのものは例外のメッセージに載せない（ログに出る）
 */
export function cachedSecureParameter<T>(
  name: string,
  parse: (raw: string) => T,
): () => Promise<T> {
  let cached: { value: T; expiresAt: number } | null = null;

  return async () => {
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const result = await ssmClient.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    const raw = result.Parameter?.Value;
    if (!raw) {
      throw new Error(`SSM パラメータが未設定です: ${name}`);
    }
    const value = parse(raw);
    cached = { value, expiresAt: Date.now() + PARAMETER_CACHE_TTL_MS };
    return value;
  };
}
