import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

const GITHUB_DOMAIN = 'token.actions.githubusercontent.com';

/**
 * 指定リポジトリの main ブランチで動く GitHub Actions だけを信頼するプリンシパル。
 * sakekasu-kakeibo の同名ファイルを写したもの（sub の実測は kakeibo のもの）。
 *
 * deploy ロール（github-oidc-stack）と cdkd ロール（cdkd-deploy-stack）の両方がこれを使う。
 * 信頼条件を 2 か所に書き写すと、片方だけ直して気づけなくなるため。
 *
 * OIDC プロバイダーは作らず、既にあるものを参照する。1 つの AWS アカウントに同じ URL の
 * プロバイダーは 1 つしか置けず、token.actions.githubusercontent.com のものは
 * sakekasu-builder の `sakekasu-github-oidc` スタックが持っている。
 *
 * sub の照合を StringLike で 2 通り書いてあるのは、GitHub が発行する sub に
 * 2 つの形式があるため。実測（2026-09-12、このリポジトリの push）はこちら。
 *
 *   repo:yuuuuuuu168@173623628/sakekasu-kakeibo@1367094471:ref:refs/heads/main
 *
 * オーナー名とリポジトリ名のうしろに数値 ID が付く。名前を変えても同一性が
 * 保たれるようにする新しい形式で、GitHub API が返すオーナー ID と
 * リポジトリ ID がそのまま入る。旧形式は ID の付かない次の形。
 *
 *   repo:yuuuuuuu168/sakekasu-kakeibo:ref:refs/heads/main
 *
 * 旧形式だけを StringEquals で書いていたために、assume が
 * 「Not authorized to perform sts:AssumeRoleWithWebIdentity」で落ち続けた。
 * AWS はロールが存在しない場合にも同じエラーを返すので、原因が見えにくい。
 *
 * ID の部分をワイルドカードにしてあるのは、リポジトリを作り直したときに
 * 同じ落ち方をしないため。`@` の前を固定しているので、オーナー名と
 * リポジトリ名は厳密に一致する必要がある（どちらも `@` を含められない）。
 */
export function githubMainBranchPrincipal(scope: Construct, repository: string): iam.WebIdentityPrincipal {
  const stack = cdk.Stack.of(scope);
  const provider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
    scope,
    'GithubOidcProvider',
    `arn:${stack.partition}:iam::${stack.account}:oidc-provider/${GITHUB_DOMAIN}`,
  );

  const [owner, repo] = repository.split('/');
  const subjects = [`repo:${owner}@*/${repo}@*:ref:refs/heads/main`, `repo:${owner}/${repo}:ref:refs/heads/main`];

  return new iam.WebIdentityPrincipal(provider.openIdConnectProviderArn, {
    StringEquals: {
      [`${GITHUB_DOMAIN}:aud`]: 'sts.amazonaws.com',
    },
    // main への push と、main から起動した workflow_dispatch だけがこの sub になる
    StringLike: {
      [`${GITHUB_DOMAIN}:sub`]: subjects,
    },
  });
}
