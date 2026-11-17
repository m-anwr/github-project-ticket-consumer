import type { DownloadedAsset, InlineReviewComment, IssueComment, ProjectItem } from '../types.ts';

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

function formatAssetsNote(assets: DownloadedAsset[]): string {
  if (assets.length === 0) return '';
  const list = assets.map((a) => `- ${a.filename} (${a.mimeType}) saved at ${a.filePath}`).join('\n');
  return `\nAttached assets from GitHub:\n${list}\n`;
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
): string {
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
  summary: string,
  inlineComments: InlineReviewComment[],
): string {
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
