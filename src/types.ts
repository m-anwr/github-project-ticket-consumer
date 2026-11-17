export const LANES = {
  BACKLOG: 'Backlog',
  READY: 'Ready',
  IN_PROGRESS: 'In progress',
  NEEDS_INPUT: 'Needs input',
  IN_REVIEW: 'In review',
  DONE: 'Done',
} as const;

export type LaneName = (typeof LANES)[keyof typeof LANES];

export type MergeMethod = 'squash' | 'merge' | 'rebase';
export type ManualMergeBehavior = 'keep_in_review' | 'move_to_done';

/**
 * How review findings and human replies reach the agent.
 *
 * `agent` - the daemon passes comment IDs and the agent fetches the comments
 * itself with the `gh` CLI. The agent sees the real comment, not a
 * transcription of it, and the prompt stays small.
 *
 * `inline` - the daemon quotes the comment bodies (and diff hunks) into the
 * prompt. Self-contained, but it re-serialises what the agent could read
 * directly, and it bloats the prompt with diff hunks the agent can regenerate
 * from its own working tree.
 */
export type CommentDeliveryMode = 'agent' | 'inline';

/**
 * Who opens the pull request.
 *
 * `agent` - the agent opens it with the `gh` CLI, so the title and the
 * description are the agent's own words and it can edit them later
 * (`gh pr edit`). The daemon finds the PR afterwards by branch name, which is
 * deterministic, so it does not have to trust the number the agent reported.
 *
 * `daemon` - the daemon opens it from the agent's final report. Used when the
 * `gh` CLI is unavailable to the agent, and as the fallback when the agent did
 * not open one: completed work is never left without a PR.
 */
export type PrOpeningMode = 'agent' | 'daemon';

export interface Config {
  githubToken: string;
  githubOwner: string;
  githubRepo: string;
  githubProjectNumber: number;
  githubAllowedAuthors: string[];
  reviewBotLogins: string[];
  reviewCheckName: string;
  requireAllChecks: boolean;
  opencodeServerUrl: string;
  opencodeProviderId: string;
  opencodeModelId: string;
  opencodeServerPassword?: string;
  opencodeServerUsername: string;
  /**
   * Inactivity timeout for the long-running OpenCode message POST, in ms.
   * 0 means no timeout.
   */
  opencodeMessageTimeoutMs: number;
  repoLocalPath: string;
  baseBranch: string;
  dataDir: string;
  pollIntervalMs: number;
  maxReviewIterations: number;
  autoMergeMethod: MergeMethod;
  manualMergeBehavior: ManualMergeBehavior;
  manualMergeLabel: string;
  readyToMergeLabel: string;
  /**
   * How review findings and human replies reach the agent. `agent` requires
   * the `gh` CLI to be available to the agent; the daemon falls back to
   * `inline` automatically when it is not.
   */
  commentDelivery: CommentDeliveryMode;
  /**
   * Who opens the pull request: the agent with `gh`, or the daemon from the
   * agent's report.
   */
  prOpening: PrOpeningMode;
  /**
   * Whether the `gh` CLI is usable by the agent. Set at startup from a real
   * probe; the prompts only tell the agent to run `gh` when it is true.
   */
  ghAvailable: boolean;
}

export interface ProjectItem {
  itemId: string;
  lane: LaneName | string;
  issueNumber: number;
  issueTitle: string;
  issueBody: string;
  issueUrl: string;
  labels: string[];
  state: 'OPEN' | 'CLOSED';
}

export interface TicketRecord {
  issueNumber: number;
  projectItemId: string;
  lane: string;
  sessionId: string | null;
  branchName: string | null;
  worktreePath: string | null;
  prNumber: number | null;
  lastCommentId: number;
  lastPushedAt: string | null;
  reviewIterations: number;
  manualMergeNotified: number;
  updatedAt: string;
}

export interface DownloadedAsset {
  filePath: string;
  mimeType: string;
  filename: string;
  sourceUrl: string;
}

export interface IssueComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface InlineReviewComment {
  id: number;
  author: string;
  path: string;
  line: number | null;
  diffHunk: string;
  body: string;
  commitId: string;
  createdAt: string;
}

export type KiloCodeReviewEvaluation =
  | { status: 'pending'; reason: string }
  | { status: 'clean'; summary: string }
  | {
      status: 'has_findings';
      summary: string;
      /** Id of the review bot's summary comment, so the agent can fetch it. */
      summaryCommentId: number | null;
      inlineComments: InlineReviewComment[];
    };

export type OpenCodeTicketStatus =
  | { status: 'needs_input'; question: string; rawText?: string }
  | {
      status: 'ready_for_review';
      prTitle?: string;
      prSummary?: string;
      /** Number of the PR the agent opened, when it opened one itself. */
      prNumber?: number;
      /**
       * The agent's final message with the `<ticket-status>` block removed.
       * This is the richest description of the work the agent produced, so it
       * is what the PR description is built from.
       */
      rawText?: string;
    }
  | { status: 'unknown'; rawText: string };
