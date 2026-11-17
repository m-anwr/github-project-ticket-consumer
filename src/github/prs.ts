import type { InlineReviewComment, KiloCodeReviewEvaluation, MergeMethod } from '../types.ts';
import type { GitHubClient } from './client.ts';

interface RawPR {
  number: number;
  state: 'open' | 'closed';
  merged: boolean;
  html_url: string;
  head: { sha: string; ref: string };
  mergeable_state?: string;
}

interface RawCheckRun {
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: string | null;
  started_at: string | null;
  completed_at: string | null;
}

interface RawIssueComment {
  id: number;
  user: { login: string } | null;
  body: string;
  created_at: string;
  updated_at: string;
}

interface RawPullReviewComment {
  id: number;
  user: { login: string } | null;
  path: string;
  line: number | null;
  original_line: number | null;
  diff_hunk: string;
  body: string;
  commit_id: string;
  created_at: string;
}

/**
 * Parses the authoritative current summary from Kilo Code's `<!-- kilo-review -->` comment,
 * stripping out `<!-- kilo-review-history -->` so older snapshots don't cause false positives.
 */
export function parseKiloCodeSummary(commentBody: string): {
  isClean: boolean;
  currentSection: string;
} {
  const historyIdx = commentBody.indexOf('<!-- kilo-review-history -->');
  const currentSection = (historyIdx >= 0 ? commentBody.slice(0, historyIdx) : commentBody).trim();

  const noIssuesMatch = /\*\*Status:\*\*\s*No Issues Found/i.test(currentSection);
  const mergeRecMatch = /\*\*Recommendation:\*\*\s*Merge\b/i.test(currentSection);
  const hasIssuesMatch = /\*\*Status:\*\*\s*\d+\s*Issues?\s*Found/i.test(currentSection) ||
    /\*\*Recommendation:\*\*\s*Address before merge/i.test(currentSection);

  return {
    isClean: noIssuesMatch && mergeRecMatch && !hasIssuesMatch,
    currentSection,
  };
}

export class GitHubPRsClient {
  private readonly client: GitHubClient;
  private readonly owner: string;
  private readonly repo: string;

  constructor(client: GitHubClient, owner: string, repo: string) {
    this.client = client;
    this.owner = owner;
    this.repo = repo;
  }

  async createOrGetPR(
    branchName: string,
    baseBranch: string,
    title: string,
    body: string,
  ): Promise<{ number: number; url: string; headSha: string }> {
    const existing = await this.client.rest<RawPR[]>(
      `/repos/${this.owner}/${this.repo}/pulls?head=${encodeURIComponent(`${this.owner}:${branchName}`)}&state=open`,
    );
    if (existing.length > 0) {
      return {
        number: existing[0].number,
        url: existing[0].html_url,
        headSha: existing[0].head.sha,
      };
    }

    const created = await this.client.rest<RawPR>(`/repos/${this.owner}/${this.repo}/pulls`, {
      method: 'POST',
      body: {
        title,
        body,
        head: branchName,
        base: baseBranch,
      },
    });
    return {
      number: created.number,
      url: created.html_url,
      headSha: created.head.sha,
    };
  }

  async getPR(prNumber: number): Promise<RawPR> {
    return this.client.rest<RawPR>(`/repos/${this.owner}/${this.repo}/pulls/${prNumber}`);
  }

  async evaluateKiloCodeReview(options: {
    prNumber: number;
    headSha: string;
    reviewBotLogins: string[];
    reviewCheckName: string;
    requireAllChecks: boolean;
    lastPushedAt: string | null;
  }): Promise<KiloCodeReviewEvaluation> {
    const { check_runs: checkRuns } = await this.client.rest<{ check_runs: RawCheckRun[] }>(
      `/repos/${this.owner}/${this.repo}/commits/${options.headSha}/check-runs?per_page=100`,
    );

    const kiloCheck = checkRuns.find(
      (c) => c.name.toLowerCase() === options.reviewCheckName.toLowerCase(),
    );

    if (!kiloCheck || kiloCheck.status !== 'completed') {
      return {
        status: 'pending',
        reason: kiloCheck
          ? `CheckRun "${options.reviewCheckName}" is ${kiloCheck.status}`
          : `Waiting for CheckRun "${options.reviewCheckName}" to start`,
      };
    }

    if (options.requireAllChecks) {
      const otherIncomplete = checkRuns.filter(
        (c) =>
          c.name.toLowerCase() !== options.reviewCheckName.toLowerCase() &&
          c.status !== 'completed',
      );
      if (otherIncomplete.length > 0) {
        return {
          status: 'pending',
          reason: `Waiting for CI checks: ${otherIncomplete.map((c) => c.name).join(', ')}`,
        };
      }
      const otherFailed = checkRuns.filter(
        (c) =>
          c.name.toLowerCase() !== options.reviewCheckName.toLowerCase() &&
          c.conclusion &&
          !['success', 'neutral', 'skipped'].includes(c.conclusion.toLowerCase()),
      );
      if (otherFailed.length > 0) {
        return {
          status: 'has_findings',
          summary: `CI check(s) failed: ${otherFailed.map((c) => `${c.name} (${c.conclusion})`).join(', ')}`,
          summaryCommentId: null,
          inlineComments: [],
        };
      }
    }

    const botSet = new Set(options.reviewBotLogins.map((b) => b.toLowerCase()));
    const issueComments = await this.client.rest<RawIssueComment[]>(
      `/repos/${this.owner}/${this.repo}/issues/${options.prNumber}/comments?per_page=100`,
    );

    const kiloSummaryComment = issueComments
      .filter((c) => c.user && botSet.has(c.user.login.toLowerCase()) && c.body.includes('<!-- kilo-review -->'))
      .at(-1);

    if (!kiloSummaryComment) {
      return {
        status: 'pending',
        reason: 'Kilo Code CheckRun completed, waiting for summary comment',
      };
    }

    // Ensure the summary comment was updated after our last push (if known)
    if (options.lastPushedAt && kiloSummaryComment.updated_at < options.lastPushedAt) {
      return {
        status: 'pending',
        reason: 'Waiting for Kilo Code summary comment to update for latest push',
      };
    }

    const parsed = parseKiloCodeSummary(kiloSummaryComment.body);

    const rawInline = await this.client.rest<RawPullReviewComment[]>(
      `/repos/${this.owner}/${this.repo}/pulls/${options.prNumber}/comments?per_page=100`,
    );

    const checkStartTime = kiloCheck.started_at || options.lastPushedAt || '';
    const inlineComments: InlineReviewComment[] = rawInline
      .filter((c) => {
        if (!c.user || !botSet.has(c.user.login.toLowerCase())) return false;
        if (c.commit_id === options.headSha) return true;
        if (checkStartTime && c.created_at >= checkStartTime) return true;
        return false;
      })
      .map((c) => ({
        id: c.id,
        author: c.user?.login || '',
        path: c.path,
        line: c.line ?? c.original_line ?? null,
        diffHunk: c.diff_hunk,
        body: c.body,
        commitId: c.commit_id,
        createdAt: c.created_at,
      }));

    if (parsed.isClean && inlineComments.length === 0) {
      return {
        status: 'clean',
        summary: parsed.currentSection,
      };
    }

    return {
      status: 'has_findings',
      summary: parsed.currentSection,
      summaryCommentId: kiloSummaryComment.id,
      inlineComments,
    };
  }

  async mergePR(prNumber: number, method: MergeMethod, branchName: string): Promise<void> {
    await this.client.rest(`/repos/${this.owner}/${this.repo}/pulls/${prNumber}/merge`, {
      method: 'PUT',
      body: { merge_method: method },
    });
    // Best-effort branch cleanup
    await this.client
      .rest(`/repos/${this.owner}/${this.repo}/git/refs/heads/${encodeURIComponent(branchName)}`, {
        method: 'DELETE',
      })
      .catch(() => undefined);
  }
}
