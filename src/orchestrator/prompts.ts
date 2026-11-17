import type {
  CommentDeliveryMode,
  DownloadedAsset,
  InlineReviewComment,
  IssueComment,
  ProjectItem,
} from '../types.ts';

const STATUS_CONTRACT = `
When you finish your turn, you MUST end your final message with a single <ticket-status> JSON block:

1. If you need clarification, credentials, design assets, or a decision from the user before continuing:
<ticket-status>
{
  "status": "needs_input",
  "question": "Clear, concise question(s) for the user"
}
</ticket-status>

2. If implementation/fixes are complete, verified (tests/typecheck/lint run where applicable), and ready for PR review:
<ticket-status>
{
  "status": "ready_for_review",
  "pr_title": "Short conventional PR title",
  "pr_summary": "Concise summary of what changed and how it was verified"
}
</ticket-status>
`.trim();

/**
 * Where the prompt's GitHub facts come from.
 *
 * In `agent` mode the daemon passes identifiers only and the agent fetches the
 * comments itself, so the prompt has to name the repository to ask.
 */
export interface PromptContext {
  mode: CommentDeliveryMode;
  owner: string;
  repo: string;
  issueNumber: number;
}

function formatAssetsNote(assets: DownloadedAsset[]): string {
  if (assets.length === 0) return '';
  const list = assets.map((a) => `- ${a.filename} (${a.mimeType}) saved at ${a.filePath}`);
  return `\nAttached assets from GitHub:\n${list.join('\n')}\n`;
}

export function buildInitialPrompt(
  item: ProjectItem,
  branchName: string,
  assets: DownloadedAsset[],
): string {
  return `You are working on GitHub Issue #${item.issueNumber}: "${item.issueTitle}"
Issue URL: ${item.issueUrl}
Git branch: ${branchName}
Labels: ${item.labels.length > 0 ? item.labels.join(', ') : 'none'}

Issue Description:
${item.issueBody || '(No description provided)'}
${formatAssetsNote(assets)}
Instructions:
- Explore the codebase in your current working directory and implement the requested fix/feature.
- Run relevant tests, typechecks, or linters to verify your changes.
- Commit your changes cleanly on branch "${branchName}" (do not switch branches).
- Only ask for input if there is genuine ambiguity or missing information you cannot resolve from the codebase.

${STATUS_CONTRACT}`;
}

export function buildHumanReplyPrompt(
  comments: IssueComment[],
  assets: DownloadedAsset[],
  ctx: PromptContext,
): string {
  if (ctx.mode === 'agent') {
    const ids = comments.map((c) => c.id);
    return `The user replied on the GitHub ticket (issue #${ctx.issueNumber}).

Read the reply yourself -- do not rely on a transcription of it:

  gh api repos/${ctx.owner}/${ctx.repo}/issues/${ctx.issueNumber}/comments --paginate

Only the comment(s) with these ids are new replies (the newest one is the reply you need):
${ids.length > 0 ? ids.join(', ') : '(none)'}
${formatAssetsNote(assets)}
Continue working on the ticket using this input. Commit your changes on the current branch when done.

If \`gh\` is unavailable or unauthenticated, say so and stop -- do not guess what the user said.

${STATUS_CONTRACT}`;
  }

  const formatted = comments
    .map((c) => `Comment by @${c.author} at ${c.createdAt}:\n${c.body}`)
    .join('\n\n---\n\n');

  return `The user replied on the GitHub ticket:

${formatted}
${formatAssetsNote(assets)}
Continue working on the ticket using this input. Commit your changes on the current branch when done.

${STATUS_CONTRACT}`;
}

export function buildReviewFindingsPrompt(
  prNumber: number,
  ctx: PromptContext,
  options: {
    headSha: string;
    botLogin: string;
    summaryCommentId: number | null;
    inlineComments: InlineReviewComment[];
    summary: string;
  },
): string {
  if (ctx.mode === 'agent') {
    const ids = options.inlineComments.map((c) => c.id);
    return `Kilo Code reviewed PR #${prNumber} and left findings. Read them yourself -- do not rely on a transcription:

  gh api repos/${ctx.owner}/${ctx.repo}/pulls/${prNumber}/comments --paginate
  gh api repos/${ctx.owner}/${ctx.repo}/issues/${prNumber}/comments --paginate

Only these review comments are in scope -- they are the ones ${options.botLogin} posted against the current head ${options.headSha}. Findings from earlier rounds are out of scope:
${ids.length > 0 ? ids.join(', ') : '(no inline comments)'}
${options.summaryCommentId !== null ? `The review summary is issue comment id ${options.summaryCommentId}.` : ''}

You have the working tree, so read the files and the diff yourself -- you do not need diff hunks quoted back to you.

Instructions:
1. Validate EACH finding against the actual codebase -- do not blindly apply changes if a finding is a false positive, already handled, or out of scope.
2. Fix all valid issues and verify with tests/typecheck.
3. Commit and push your fixes to the current PR branch (or if all findings were invalid/false positives, explain why in your summary).

If \`gh\` is unavailable or unauthenticated, say so and stop -- do not guess what the reviewer wrote.

${STATUS_CONTRACT}`;
  }

  const summary = options.summary;
  const inlineComments = options.inlineComments;
  const inlineText =
    inlineComments.length > 0
      ? inlineComments
          .map(
            (c, idx) =>
              `### Finding ${idx + 1}: \`${c.path}\`${c.line ? ` (line ${c.line})` : ''}\n` +
              `\`\`\`diff\n${c.diffHunk}\n\`\`\`\n` +
              `${c.body}`,
          )
          .join('\n\n')
      : '(No inline diff comments — see summary above.)';

  return `Kilo Code reviewed PR #${prNumber} and posted the following feedback.

## Review Summary
${summary}

## Inline Findings
${inlineText}

Instructions:
1. Validate EACH finding against the actual codebase—do not blindly apply changes if a finding is a false positive, already handled, or out of scope.
2. Fix all valid issues and verify with tests/typecheck.
3. Commit and push your fixes to the current PR branch (or if all findings were invalid/false positives, explain why in your summary).

${STATUS_CONTRACT}`;
}
