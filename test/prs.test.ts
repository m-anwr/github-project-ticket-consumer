import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GitHubPRsClient } from '../src/github/prs.ts';

/**
 * The freshness gate that decides whether a review belongs to the CURRENT
 * head of the pull request.
 *
 * The check run is fetched by head SHA, so its start time IS the start of
 * the review of the current head. The daemon's own `lastPushedAt` must not be
 * used for that comparison: it records when the daemon's bookkeeping ran, and
 * since the agent pushes the branch itself, that can be later than the review
 * the daemon is waiting for -- which stalls the ticket forever, because the
 * head never changes again and the reviewer never re-runs.
 */

function makeClient(handlers: Record<string, unknown>): never {
  const rest = async (path: string): Promise<unknown> => {
    for (const [prefix, value] of Object.entries(handlers)) {
      if (path.startsWith(prefix)) return value;
    }
    throw new Error(`unexpected path: ${path}`);
  };
  return { rest } as never;
}

const CHECK_RUN = {
  name: 'Kilo Code Review',
  status: 'completed',
  conclusion: 'success',
  started_at: '2026-11-17T18:51:57Z',
  completed_at: '2026-11-17T18:53:09Z',
};

const CLEAN_SUMMARY = '<!-- kilo-review -->\n\n**Status:** No Issues Found | **Recommendation:** Merge';

const OPTIONS = {
  prNumber: 103,
  headSha: 'abc123',
  reviewBotLogins: ['kilo-code-bot[bot]'],
  reviewCheckName: 'Kilo Code Review',
  requireAllChecks: false,
  // the daemon's bookkeeping ran 40 seconds AFTER the review completed
  lastPushedAt: '2026-11-17T18:53:52.233Z',
};

function summaryComment(updatedAt: string) {
  return [
    {
      id: 1,
      user: { login: 'kilo-code-bot[bot]' },
      body: CLEAN_SUMMARY,
      created_at: '2026-11-17T18:50:15Z',
      updated_at: updatedAt,
    },
  ];
}

describe('evaluateKiloCodeReview', () => {
  it('accepts the summary of the current review even when the daemon last pushed later', async () => {
    const prs = new GitHubPRsClient(
      makeClient({
        '/repos/o/r/commits': { check_runs: [CHECK_RUN] },
        '/repos/o/r/issues': summaryComment('2026-11-17T18:53:12Z'),
        '/repos/o/r/pulls': [],
      }),
      'o',
      'r',
    );

    const out = await prs.evaluateKiloCodeReview(OPTIONS);
    assert.equal(out.status, 'clean');
  });

  it('still waits when the summary belongs to an earlier review', async () => {
    const prs = new GitHubPRsClient(
      makeClient({
        '/repos/o/r/commits': { check_runs: [CHECK_RUN] },
        // written before this review started
        '/repos/o/r/issues': summaryComment('2026-11-17T18:40:00Z'),
        '/repos/o/r/pulls': [],
      }),
      'o',
      'r',
    );

    const out = await prs.evaluateKiloCodeReview(OPTIONS);
    assert.equal(out.status, 'pending');
  });

  it('waits while the check run for the current head is still running', async () => {
    const prs = new GitHubPRsClient(
      makeClient({
        '/repos/o/r/commits': {
          check_runs: [{ ...CHECK_RUN, status: 'in_progress', conclusion: null }],
        },
        '/repos/o/r/issues': summaryComment('2026-11-17T18:53:12Z'),
        '/repos/o/r/pulls': [],
      }),
      'o',
      'r',
    );

    const out = await prs.evaluateKiloCodeReview(OPTIONS);
    assert.equal(out.status, 'pending');
  });

  it('ignores a finding from an earlier round that GitHub re-pointed at the current head', async () => {
    // GitHub re-points a review comment's `commit_id` at the new head when
    // the head moves. The comment was really made against the previous
    // commit, and the agent already fixed it -- so it must not be counted as
    // a finding for this round.
    const staleFinding = {
      id: 4604213938,
      user: { login: 'kilo-code-bot[bot]' },
      path: 'be/supabase/migrations/20261117000000_announcement_date_ranges.sql',
      line: 15,
      original_line: 15,
      diff_hunk: '@@ -1,3 +1,4 @@',
      body: '**WARNING:** Preserve announcement IDs when consolidating rows',
      commit_id: 'abc123', // the current head -- GitHub re-pointed it
      original_commit_id: 'oldcommit', // where it was really made
      created_at: '2026-11-17T18:50:00Z', // before this review started
    };

    const prs = new GitHubPRsClient(
      makeClient({
        '/repos/o/r/commits': { check_runs: [CHECK_RUN] },
        '/repos/o/r/issues': summaryComment('2026-11-17T18:53:12Z'),
        '/repos/o/r/pulls': [staleFinding],
      }),
      'o',
      'r',
    );

    const out = await prs.evaluateKiloCodeReview(OPTIONS);
    assert.equal(out.status, 'clean');
  });

  it('counts a finding made against the current head', async () => {
    const currentFinding = {
      id: 99,
      user: { login: 'kilo-code-bot[bot]' },
      path: 'fe/app/x.vue',
      line: 3,
      original_line: 3,
      diff_hunk: '@@ -1,3 +1,4 @@',
      body: 'Something to fix',
      commit_id: 'abc123',
      original_commit_id: 'abc123',
      created_at: '2026-11-17T18:52:30Z',
    };

    const prs = new GitHubPRsClient(
      makeClient({
        '/repos/o/r/commits': { check_runs: [CHECK_RUN] },
        '/repos/o/r/issues': summaryComment('2026-11-17T18:53:12Z'),
        '/repos/o/r/pulls': [currentFinding],
      }),
      'o',
      'r',
    );

    const out = await prs.evaluateKiloCodeReview(OPTIONS);
    assert.equal(out.status, 'has_findings');
    assert.equal(
      out.status === 'has_findings' ? out.inlineComments.length : 0,
      1,
    );
  });
});
