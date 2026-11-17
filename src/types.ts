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
  | { status: 'needs_input'; question: string }
  | { status: 'ready_for_review'; prTitle?: string; prSummary?: string }
  | { status: 'unknown'; rawText: string };
