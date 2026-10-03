// PostToolUse フック。PR を作った直後に、その PR を watch するよう Claude に伝える。
//
// CLAUDE.md に書くだけだと、長いセッションでは押し流されて「watch して」と
// 毎回言い直すことになる。PR 作成の直後という確実な位置で、番号まで添えて渡す。
//
// PostToolUse の素の標準出力は Claude に届かない（デバッグログ行き）ため、
// hookSpecificOutput.additionalContext を持つ JSON で返す。
// 判断材料を足すだけのフックなので、何が起きても異常終了はさせない。

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

// MCP ツールの返り値は、構造化されたオブジェクトのことも、JSON を丸ごと入れた
// 文字列（content[].text）のこともある。どちらでも拾えるよう再帰で探す
function findPullNumber(value, depth = 0) {
  if (depth > MAX_DEPTH || value == null) return null;

  if (typeof value === 'string') {
    const fromUrl = value.match(/\/pull\/(\d+)/);
    if (fromUrl) return Number(fromUrl[1]);
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return findPullNumber(JSON.parse(trimmed), depth + 1);
      } catch {
        return null;
      }
    }
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPullNumber(item, depth + 1);
      if (found !== null) return found;
    }
    return null;
  }

  if (typeof value === 'object') {
    // html_url は PR そのものを指す。number は review や issue の入れ子でも
    // 同じ名前で出るため、URL から取れたときはそちらを優先する
    const fromUrl = findPullNumber(value.html_url, depth + 1);
    if (fromUrl !== null) return fromUrl;
    if (Number.isInteger(value.number)) return value.number;
    for (const item of Object.values(value)) {
      const found = findPullNumber(item, depth + 1);
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
const owner = typeof toolInput.owner === 'string' ? toolInput.owner : null;
const repo = typeof toolInput.repo === 'string' ? toolInput.repo : null;
const number = findPullNumber(payload.tool_response);

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
