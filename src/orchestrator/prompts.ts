import type {
  CommentDeliveryMode,
  DownloadedAsset,
  InlineReviewComment,
  IssueComment,
  OpenCodeTicketStatus,
  PrOpeningMode,
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
  "pr_number": 123,
  "pr_title": "Short conventional PR title",
  "pr_summary": "Concise summary of what changed and how it was verified"
}
</ticket-status>

"pr_number" is optional -- include it when you opened the pull request yourself.
`.trim();

/**
 * Where the prompt's GitHub facts come from, and what the agent is expected
 * to do with them.
 */
export interface PromptContext {
  /** How review findings and human replies reach the agent. */
  mode: CommentDeliveryMode;
  owner: string;
  repo: string;
  issueNumber: number;
  /** The branch the agent works on. */
  branchName: string;
  /** The branch the pull request targets. */
  baseBranch: string;
  /**
   * Where the agent should write the pull request description. It is outside
   * the repository on purpose, so it cannot end up in the diff.
   */
  prBodyPath: string;
  /** The pull request, when one is already open for this ticket. */
  prNumber?: number;
  /** Whether the agent is expected to open the pull request itself. */
  prOpening: PrOpeningMode;
}

function formatAssetsNote(assets: DownloadedAsset[]): string {
  if (assets.length === 0) return '';
  const list = assets.map((a) => `- ${a.filename} (${a.mimeType}) saved at ${a.filePath}`);
  return `\nAttached assets from GitHub:\n${list.join('\n')}\n`;
}

export function buildInitialPrompt(
  item: ProjectItem,
  assets: DownloadedAsset[],
  ctx: PromptContext,
): string {
  const openPr =
    ctx.prOpening === 'agent'
      ? `
- Open the pull request yourself, once the branch is pushed to origin:
    gh pr create --base ${ctx.baseBranch} --head ${ctx.branchName} --title "<conventional title>" --body-file ${ctx.prBodyPath}
  Write the description to ${ctx.prBodyPath} first. It is outside the repository, so it will not appear in the diff.
  The description must cover: what changed, how you verified it (the commands you ran and their results), and anything still open (placeholders, follow-ups, or things you could not do). Do not guess at values you could not verify.
  Include the line "Closes #${item.issueNumber}" so the issue closes when the PR merges.
  If the \`gh\` command fails, say so in your final message instead of reporting the work as ready.`
      : '';

  return `You are working on GitHub Issue #${item.issueNumber}: "${item.issueTitle}"
Issue URL: ${item.issueUrl}
Git branch: ${ctx.branchName}
Labels: ${item.labels.length > 0 ? item.labels.join(', ') : 'none'}

Issue Description:
${item.issueBody || '(No description provided)'}
${formatAssetsNote(assets)}
Instructions:
- Explore the codebase in your current working directory and implement the requested fix/feature.
- Run relevant tests, typechecks, or linters to verify your changes.
- Commit your changes cleanly on branch "${ctx.branchName}" (do not switch branches) and push the branch to origin.
${openPr}
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
Continue working on the ticket using this input, on branch "${ctx.branchName}". Commit your changes on that branch when done.
${ctx.prNumber ? `The pull request #${ctx.prNumber} is already open; push to the same branch.\n` : ''}
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
  const pushNote = `The pull request is already open (#${prNumber}) on branch "${ctx.branchName}". Push your fixes to that branch -- the PR updates automatically. If the fixes change what the PR does, update the description:
  gh pr edit ${prNumber} --body-file ${ctx.prBodyPath}`;

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

${pushNote}

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

${pushNote}

${STATUS_CONTRACT}`;
}

/**
 * The pull request description the daemon writes when the agent did not open
 * the pull request itself.
 *
 * It is the agent's own final report -- not a re-summary of it -- plus the
 * closing line. The report is where the agent puts what it verified and what
 * it could not do, which is what a reviewer needs and what `pr_summary` only
 * sometimes carries.
 */
export function buildPrBody(outcome: OpenCodeTicketStatus, issueNumber: number): string {
  const report = outcome.rawText?.trim();
  const summary =
    outcome.status === 'ready_for_review' ? outcome.prSummary?.trim() : undefined;
  const body = report || summary || 'Automated implementation by OpenCode.';
  return `${body}\n\nCloses #${issueNumber}`;
}
