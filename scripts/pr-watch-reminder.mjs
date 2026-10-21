// PostToolUse フック。PR を作った直後に、その PR を watch するよう Claude に伝える。
//
// CLAUDE.md に書くだけだと、長いセッションでは押し流されて「watch して」と
// 毎回言い直すことになる。PR 作成の直後という確実な位置で、番号まで添えて渡す。
//
// PostToolUse の素の標準出力は Claude に届かない（デバッグログ行き）ため、
// hookSpecificOutput.additionalContext を持つ JSON で返す。
// 判断材料を足すだけのフックなので、何が起きても異常終了はさせない。
//
// 発火するのは 2 通り（.claude/settings.json の PostToolUse）。
//   - MCP の create_pull_request。番号は返り値から拾う
//   - Bash。gh pr create を含むコマンドのときだけ念押しを出し、それ以外は黙って終わる。
//     gh は作った PR の URL を標準出力に出すので、そこから拾う

const MAX_DEPTH = 6;

function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      raw += chunk;
    });
    process.stdin.on('end', () => resolve(raw));
    process.stdin.on('error', () => resolve(''));
  });
}

// PR の URL（https://github.com/<owner>/<repo>/pull/<番号>）。owner と repo も拾う
const PULL_URL = /https?:\/\/[^/\s]+\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/;

// gh pr create の呼び出し。行頭か区切り（; & | ( 改行）の直後にある gh だけを見る
// （echo gh pr create のような引数は拾わない）。gh の後ろの -R / --repo は挟まってもよい
const GH_PR_CREATE = /(?:^|[;&|(\n])\s*gh\s+(?:(?:-R|--repo)(?:\s+|=)\S+\s+)?pr\s+create\b/;

// 返り値から PR を探す。見つかれば { number, owner?, repo? }。
// MCP ツールの返り値は、構造化されたオブジェクトのことも、JSON を丸ごと入れた
// 文字列（content[].text）のこともある。どちらでも拾えるよう再帰で探す
function findPull(value, depth = 0) {
  if (depth > MAX_DEPTH || value == null) return null;

  if (typeof value === 'string') {
    const fromUrl = value.match(PULL_URL);
    if (fromUrl) return { owner: fromUrl[1], repo: fromUrl[2], number: Number(fromUrl[3]) };
    const bare = value.match(/\/pull\/(\d+)/);
    if (bare) return { number: Number(bare[1]) };
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return findPull(JSON.parse(trimmed), depth + 1);
      } catch {
        return null;
      }
    }
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPull(item, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }

  if (typeof value === 'object') {
    // html_url は PR そのものを指す。number は review や issue の入れ子でも
    // 同じ名前で出るため、URL から取れたときはそちらを優先する
    const fromUrl = findPull(value.html_url, depth + 1);
    if (fromUrl !== null) return fromUrl;
    if (Number.isInteger(value.number)) return { number: value.number };
    for (const item of Object.values(value)) {
      const found = findPull(item, depth + 1);
      if (found !== null) return found;
    }
  }

  return null;
}

const raw = await readStdin();

let payload = {};
try {
  payload = JSON.parse(raw);
} catch {
  process.exit(0);
}

const toolInput = payload.tool_input ?? {};

// Bash は全コマンドで発火する。gh pr create でなければ何も出さない
if (payload.tool_name === 'Bash') {
  const command = typeof toolInput.command === 'string' ? toolInput.command : '';
  if (!GH_PR_CREATE.test(command)) process.exit(0);
}

const pull = findPull(payload.tool_response);
// gh pr create --help や失敗した呼び出しでは URL が出ない。PR を作っていないので黙って終わる
if (payload.tool_name === 'Bash' && !pull?.owner) process.exit(0);
// MCP は入力に owner / repo がある。gh は URL から拾った値を使う
const owner = typeof toolInput.owner === 'string' ? toolInput.owner : (pull?.owner ?? null);
const repo = typeof toolInput.repo === 'string' ? toolInput.repo : (pull?.repo ?? null);
const number = pull?.number ?? null;

const target =
  owner && repo && number !== null
    ? `owner=${owner} repo=${repo} pullNumber=${number}`
    : '作成した PR の owner / repo / 番号';

const context = [
  'PR を作成した。CLAUDE.md の運用どおり、ユーザーの指示を待たずに続けて',
  `subscribe_pr_activity を ${target} で呼び、この PR の CI とレビューを watch する。`,
  'watch を始めたことは、URL とあわせて一行で報告する。',
  'すでに同じ PR を watch している場合は、この指示は無視してよい。',
].join(' ');

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: context,
    },
  }),
);
