# AWS インフラの共通ルール

sakekasu の 5 リポジトリ（reinvent、builder、kakeibo、learning、integrated_environment）は、
同じ AWS アカウント・同じリージョン（ap-northeast-1）に同居している。あるアプリのデプロイが
他のアプリを壊さないように、デプロイ用ロールとアプリのロールに同じ作りの柵を立ててある。

`infra/` の CDK、デプロイのワークフロー、IAM のどれかを触るときは、このルールに従う。
決めた理由も書いてあるので、合わない場面が出たら理由のほうを読んで判断する。
ここを変えたら 5 リポジトリに `/template-sync` で配る。

## 1. 同居しているもの

| アプリ | App タグ | 名前の接頭辞（ロール・管理ポリシー） | cdkd のスタック名 |
| --- | --- | --- | --- |
| reinvent | `reinvent` | `ReinventPlanner` | `ReinventPlanner*` |
| builder | `builder` | `sakekasu-dev-` など環境ごと | `sakekasu-dev*`、`sakekasu-staging*`、`sakekasu-prod*` |
| kakeibo | `kakeibo` | `sakekasu-kakeibo-` | `sakekasu-kakeibo*` |
| learning | `learning` | `sakekasu-learning-` | `sakekasu-learning*` |
| integrated | `integrated` | `sakekasu-integrated-` | `sakekasu-integrated*` |

全アプリで 1 つずつしか無く、共用しているもの:

- cdkd の状態バケット `cdkd-state-<アカウント ID>`（キーは `cdkd/<スタック名>/<リージョン>/state.json`）
- cdkd の資産置き場 `cdkd-assets-<アカウント ID>-<リージョン>`。reinvent だけは CDK bootstrap の
  `cdk-hnb659fds-assets-<アカウント ID>-<リージョン>` を使う（`cdk.json` の `useCdkBootstrapAssets`）
- GitHub の OIDC プロバイダー。builder の `sakekasu-github-oidc` スタックが持ち、他は参照する
- 共通ログインのユーザープール（integrated）。**作り直さない。** sub が変わり、4 アプリのデータとのひも付けが切れる
- 監視の通知先（integrated の SNS トピック）

新しいアプリやスタック名の系統を足したら、全リポジトリの `deploy-guardrail` の
`CDKD_STACK_NAME_PATTERNS` に足す。足さないと、そのアプリの状態を他のアプリから守れない。

## 2. 名前とタグ

- スタック名、IAM ロール名、管理ポリシー名は、アプリの接頭辞で始める。ガードレールはロールとポリシーを
  名前で絞っている（ロールには App タグを付けていないため）
- 全リソースに App タグを付ける（`Tags.of(app).add('App', '<アプリ>')`）。コスト配分と、ガードレール・境界の
  「他のアプリのリソースに触れない」の判定に使う
- **IAM ロールには App タグを付けない**（`excludeResourceTypes: ['AWS::IAM::Role']`）。CloudFormation から
  cdkd へ移したロールは物理名が CloudFormation の命名のままで、プロパティを変えると作り直しになる
  （「6. cdkd の落とし穴」）。2026-10-04 にタグを足しただけで作り直しが起き、Lambda が消えたロールを指して止まった
- IAM ロールの description は ASCII だけにする。日本語を入れるとデプロイが 400 で落ちる

## 3. スタックのつなぎ方

- **スタックの間は参照でつながない。`crossRegionReferences` を使わない。** ゾーン ID や証明書の ARN などは
  `cdk.json` の context で渡す。`crossRegionReferences` は CDK がカスタムリソース（SSM の書き込み・読み出し）で
  作る仕組みで、cdkd に取り込むとカスタムリソースの戻り値が記録されず、別の値が入る恐れがある
- 他のアプリのリソース（App タグが自分以外のもの）を、アプリのロールから使わない。Permissions Boundary が
  拒否するので、デプロイは通っても実行時に AccessDenied になる。どうしても要るなら、境界とガードレールを
  見直す変更を別に起こす

## 4. デプロイ

- **アプリのスタックのデプロイは main へのマージ経由だけ**（deploy ワークフローが cdkd で出す）。
  手元から `cdkd deploy` も `cdk deploy` も打たない
- **cdkd に移したスタックに `cdk deploy` をしない。** CloudFormation のスタックが新しく作られ、
  同じ名前のリソースを二重に作ろうとする
- 例外は、GitHub Actions が引き受けるロールのスタック（CloudFormation）。自動のデプロイで自分の権限の出どころを
  書き換えて締め出す事故を避けるため、Mac から人が入れる。手順は次のとおり

  ```sh
  git pull
  npm ci                                    # infra（reinvent は app/infra）で
  AWS_PROFILE=sakekasu-builder npx cdk diff <ロールのスタック> -c <フラグ>=true
  # 差分が PR に書いたものだけなのを確かめてから
  AWS_PROFILE=sakekasu-builder npx cdk deploy <ロールのスタック> -c <フラグ>=true
  ```

  | アプリ | ロールのスタック | フラグ |
  | --- | --- | --- |
  | builder | `sakekasu-github-oidc` | `github-oidc` |
  | integrated | `sakekasu-integrated-github-oidc` | `github-oidc` |
  | reinvent | `ReinventPlannerGithubDeploy` | `githubDeploy` |
  | kakeibo | `sakekasu-kakeibo-github-oidc` | `github-oidc` |
  | learning | `sakekasu-learning-github-oidc` | `github-oidc` |

  kakeibo の `sakekasu-kakeibo-cdkd-deploy` と integrated の cdkd-deploy スタックは、deploy ワークフローが
  cdkd より先に毎回入れる。手で打たなくてよい

- diff にロールの削除や `replace` が出たら、デプロイせずに止まって理由を調べる
- cdkd はスタックが失敗しても終了コード 0 で抜けることがある。deploy ワークフローは出力を
  `Failed: |node\(s\) failed|Rollback completed` で grep し、当たったら落とす
- 置き換えとデータを持つリソースの削除は、`cdkd diff --json` を読んで止めるのが安全
  （reinvent の `app/infra/scripts/check-cdkd-diff.mjs`）
- cdkd の版は `infra/package.json` で固定する。上げるときは 1 リポジトリで試してから揃える

## 5. デプロイ用ロールのガードレール

cdkd 用ロールは AdministratorAccess を持つ（builder と integrated は、使うサービスだけを並べた許可リスト）。その上に Deny だけのポリシー
`deploy-guardrail` を重ねて、壊れる範囲を自分のアプリに留める。防ぎたいのは cdkd の誤った差分などの事故で、
悪意のある main の変更は止められない（このポリシー自体を書き換えられる）。

| Sid | 何を止めるか |
| --- | --- |
| `DenyOtherAppsResources` | App タグが自分以外のリソースへの操作（`Null` と `StringNotEquals` を組み、タグの無いものは通す） |
| `DenyForeignAppTag` | 自分以外の App タグを付けて作る・付け替える |
| `DenyRolesOutsideApp` | 自分の接頭辞の外の IAM ロール・管理ポリシーの作成や変更 |
| `DenyTamperingWithGithubActionsRoles` | GitHub Actions のロール自身の書き換え（接頭辞の範囲に入るため別に止める） |
| `DenyIdentityAndAccountControl` | IAM ユーザー・アクセスキー・MFA・ID プロバイダー、Organizations、アカウント設定、SSO、CloudTrail の停止や削除 |
| `DenyChangingCdkdStateBucket` | 状態バケットの削除と、削除と同じ結果になる設定変更 |
| `DenyWritingOtherAppsState` | 他のアプリの状態の書き換え・削除 |
| `DenyDestroyingSharedAssets` | 資産置き場の削除と、削除と同じ結果になる設定変更 |
| `DenyRoleWritesWithoutBoundary` ほか 2 つ | 下の「Permissions Boundary」 |
| `DenyAgentRuntimesOutsideApp` | learning だけ。AgentCore Runtime はタグを付けていないので名前で絞る |

置き場所: builder `infra/lib/deploy-guardrail.ts`（管理ポリシー）、integrated `infra/lib/deploy-guardrail.ts`
（管理ポリシー）、kakeibo `infra/lib/deploy-guardrail.ts`、learning `infra/lib/deploy-guardrail.ts`、
reinvent `app/infra/lib/deploy-guardrail.mjs`。

- 文を足すときは 5 リポジトリで同じにする。中身がずれると、どのアプリが何を守っているか追えなくなる
- インラインポリシーは 1 ロールあたり合計 10,240 文字まで。超えるなら管理ポリシー（6,144 文字まで）に分ける
- 否定の条件演算子（`StringNotEquals`、`ArnNotEquals` など）は、キーが無いときにも当たる。
  タグの無いリソースを巻き込みたくないときは `Null` を組む
- 変えたら Access Analyzer（`aws accessanalyzer validate-policy`）と `aws iam simulate-custom-policy` で確かめる。
  simulate にはポリシーの中身を `"$(cat file.json)"` で渡す（`file://` だと invalid content になる）

## 6. アプリのロールの Permissions Boundary

デプロイ用ロールは自分の接頭辞のロールを作り替えられるので、Lambda の実行ロールに管理者相当を書き込み、
関数を差し替えて呼べば、ガードレールの外に届く。アプリのロールには境界を付けて、実効権限を
「ロール自身のポリシー ∩ 境界」で頭打ちにする。

| アプリ | 境界の管理ポリシー | 作るスタック |
| --- | --- | --- |
| builder | `sakekasu-role-boundary` | `sakekasu-github-oidc` |
| integrated | `sakekasu-integrated-role-boundary`（許可リスト） | cdkd-deploy |
| kakeibo | `sakekasu-kakeibo-role-boundary` | `sakekasu-kakeibo-cdkd-deploy` |
| learning | `sakekasu-learning-role-boundary` | `sakekasu-learning-github-oidc` |
| reinvent | `ReinventPlannerRoleBoundary` | `ReinventPlannerGithubDeploy` |

- 境界の中身は「Allow `*` から、昇格と他のアプリに届くものを Deny で抜く」形。抜くのは IAM 全般、
  STS のロールの引き受けと一時的な認証情報（`sts:AssumeRole*`、`GetFederationToken`、`GetSessionToken`）、
  Organizations・account・SSO・identitystore、CloudTrail の停止や変更、他のアプリの App タグ、
  cdkd の状態バケット、資産置き場への書き込み
- **`sts:*` をまるごと拒否しない。** Claude API の ID 連携は Lambda や AgentCore Runtime から
  `sts:GetWebIdentityToken` を呼ぶ。取れるのは外部向けの ID トークンで、AWS の権限は増えない
- 境界は CloudFormation のスタック（GitHub Actions のロールと同じ側）で作る。cdkd に作らせると、
  cdkd 自身が境界を書き換えて外せる
- 境界はアプリのスタックすべてに `iam.PermissionsBoundary.of(stack).apply(...)` で付ける。
  GitHub Actions のロールのスタックには付けない（cdkd 用ロールが `iam:*` を拒否されて動かなくなる）
- ガードレールに次の 3 つを足す
  - `DenyRoleWritesWithoutBoundary`：`CreateRole`、`PutRolePolicy`、`AttachRolePolicy`、
    `PutRolePermissionsBoundary` を、`iam:PermissionsBoundary` が境界の ARN でなければ拒否する
  - `DenyRemovingBoundaryAndTrust`：`DeleteRolePermissionsBoundary` と `UpdateAssumeRolePolicy`
  - `DenyRewritingBoundary`：境界ポリシーの版の作成・削除・切り替えと、ポリシーの削除
- `iam:PermissionsBoundary` を渡すのは `CreateRole`、`PutRolePolicy`、`DeleteRolePolicy`、`AttachRolePolicy`、
  `DetachRolePolicy`、`PutRolePermissionsBoundary`、`DeleteRolePermissionsBoundary` だけ。`TagRole` などに
  条件付きの Deny を付けると、境界が正しくても常に拒否される
- 権限を減らす操作（`DeleteRolePolicy`、`DetachRolePolicy`、`DeleteRole`）は止めない。
  cdkd が境界の無い古いロールを消せなくなる
- 境界を初めて入れるときの順番
  - 境界が deploy ワークフローで入るスタックにあるなら、1 つの PR でよい（kakeibo）
  - 境界が手で入れるスタックにあるなら 2 段に分ける（reinvent、learning）。1 本目で境界とガードレールを作って
    Mac から入れ、2 本目でアプリのスタックに付ける。同じ PR にすると、境界がまだ無いうちに cdkd が付けようとして落ちる。
    1 本目と 2 本目の間は、ロールのポリシーを変えるデプロイが止まる
- 境界を足す前に、対象のロールの名前が cdkd の導く名前と一致するかを確かめる（次の節）。
  一致しないロールは境界の対象から外す（reinvent の `ROLES_WITHOUT_BOUNDARY`）。外したロールを作り直す変更は、
  境界なしの `CreateRole` として AccessDenied で止まる。黙って作り直されるより、止まって人が見るほうを選んだ

## 7. cdkd の落とし穴

- **ロールの名前が食い違うと作り直しになる。** cdkd 0.294.7 は、ロールを更新するたびに名前を導き直し、
  実物の名前と違えばロールを作り直す。導き方は次のとおり
  - `RoleName` を書いていれば、その値
  - 書いていなければ `<スタック名>-<論理 ID>` の英数字とハイフン以外を `-` にしたもの。64 文字を超えると、
    先頭 55 文字に `-` と、元の文字列の sha256 の先頭 8 文字を足す

  CloudFormation 時代に作ったロール（`<スタック名>-<論理 ID の頭>-<ランダム>`）は一致しない。作り直しの最中は
  関数が消えたロールを指して止まる。ロールのプロパティ（タグ、境界、信頼ポリシーなど）を変える PR では、
  実物のロール名（`aws iam list-roles`）と照らし合わせる。境界は、名前が一致していれば
  `PutRolePermissionsBoundary` だけでその場で付く
- **資産の上書きは止められない。** 資産置き場のキーは中身のハッシュだけで、アプリの接頭辞が無い。cdkd は
  `HeadObject` で有無を見てから `PutObject` するだけで、上書きを拒む条件を付けていない。止められるのは削除と、
  削除と同じ結果になるバケットの設定変更まで
- **cdkd は全スタックの状態を読もうとする。** diff 用ロールを自分の状態だけに絞っていると、他のアプリの状態で
  `AccessDenied` が大量に出る。結果には影響しないが、ログにアカウント ID とバケット名がそのまま出る。
  公開リポジトリでは、diff の結果を PR のコメントに貼る前にこれらを伏せる
- 取り込み（`cdkd import`）と戻し（`cdkd export`）の不具合と回避は、builder の `docs/cdkd-migration.md` の
  「cdkd の版と、先行リポジトリで判明している不具合」にまとめてある（リージョンの取り違え、
  Cloud Control の識別子の食い違い、`export` のインラインポリシー）
- CloudFormation から移したリソースには `aws:cloudformation:*` のタグが残る。動作には関係しない。
  消さなくてよい

## 8. Mac での作業

- リポジトリを iCloud Drive（デスクトップや書類）に置いていると、`.git` の中に「`main 2`」のような
  重複ファイルができて `git pull` が壊れる。次で消してから取り直す

  ```sh
  find .git \( -name '* [0-9]' -o -name '* [0-9].*' \) -print -delete
  git fetch --prune && git pull
  ```

  直したあとも、`git log -1` が GitHub の main と同じになっていることを確かめてから diff を見る。
  古いコードのまま diff を取ると「差分なし」になり、デプロイして良いかを見誤る
- 手元の AWS CLI と CDK には `AWS_PROFILE=sakekasu-builder` を付ける。切れていたら
  `aws sso login --profile sakekasu-builder`
- `npx cdk` が「Need to install the following packages」と訊いてきたら、`npm ci` を忘れている。
  そのまま進めると、リポジトリと違う版の CDK で動く

## 9. 公開リポジトリ

kakeibo、builder、integrated_environment は公開している。これらには次を書かない。

- AWS のアカウント ID（`<アプリのアカウント ID>` のように書く。コードでは `Stack.of(this).account` や
  `CDK_DEFAULT_ACCOUNT` から取る。テストは `123456789012`）
- 個人のデータ、認証情報、Secrets Manager や SSM に入れる値
- アカウント ID を含む出力（バケット名など）を GitHub Actions のジョブの間で受け渡すと、
  `secrets.AWS_ACCOUNT_ID` と同じ値を含むとして捨てられる。kakeibo の deploy ワークフローのように、
  アカウントの部分を置き換えて渡し、受け取った側で戻す
