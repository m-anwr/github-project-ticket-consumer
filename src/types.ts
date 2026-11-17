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
  repoLocalPath: string;
  baseBranch: string;
  dataDir: string;
  pollIntervalMs: number;
  maxReviewIterations: number;
  autoMergeMethod: MergeMethod;
  manualMergeBehavior: ManualMergeBehavior;
  manualMergeLabel: string;
  readyToMergeLabel: string;
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
  | { status: 'has_findings'; summary: string; inlineComments: InlineReviewComment[] };

export type OpenCodeTicketStatus =
  | { status: 'needs_input'; question: string }
  | { status: 'ready_for_review'; prTitle?: string; prSummary?: string }
  | { status: 'unknown'; rawText: string };
