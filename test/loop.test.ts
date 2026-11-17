import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { TicketStore } from '../src/db/store.ts';
import { TicketOrchestrator } from '../src/orchestrator/loop.ts';
import {
  LANES,
  type Config,
  type KiloCodeReviewEvaluation,
  type OpenCodeTicketStatus,
  type ProjectItem,
} from '../src/types.ts';

function makeConfig(dataDir: string): Config {
  return {
    githubToken: 'test-token',
    githubOwner: 'your-org',
    githubRepo: 'your-repo',
    githubProjectNumber: 1,
    githubAllowedAuthors: ['your-username'],
    reviewBotLogins: ['kilo-code-bot[bot]'],
    reviewCheckName: 'Kilo Code Review',
    requireAllChecks: true,
    opencodeServerUrl: 'http://127.0.0.1:4096',
    opencodeProviderId: 'anthropic',
    opencodeModelId: 'claude-sonnet',
    opencodeServerUsername: 'opencode',
    repoLocalPath: dataDir,
    baseBranch: 'main',
    dataDir,
    pollIntervalMs: 15000,
    maxReviewIterations: 2,
    autoMergeMethod: 'squash',
    manualMergeBehavior: 'keep_in_review',
    manualMergeLabel: 'manual merge',
    readyToMergeLabel: 'ready to merge',
  };
}

describe('TicketOrchestrator', () => {
  it('runs Ready -> Needs input -> In review -> Kilo Code fix -> Auto-merge -> Done', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orchestrator-test-'));
    const store = new TicketStore(join(dir, 'state.db'));

    try {
      let currentLane: string = LANES.READY;
      let commentSeq = 10;
      const postedComments: Array<{ issue: number; body: string }> = [];
      let humanComments: Array<{
        id: number;
        author: string;
        body: string;
        createdAt: string;
        updatedAt: string;
      }> = [];
      let opencodeOutcome: OpenCodeTicketStatus = {
        status: 'needs_input',
        question: 'Which color?',
      };
      let reviewState: KiloCodeReviewEvaluation = {
        status: 'has_findings',
        summary: '1 Issue Found',
        inlineComments: [
          {
            id: 1,
            author: 'kilo-code-bot[bot]',
            path: 'src/a.ts',
            line: 10,
            diffHunk: '@@ -10 +10 @@',
            body: 'Null check missing',
            commitId: 'sha1',
            createdAt: '2026-11-17T10:00:00Z',
          },
        ],
      };
      let mergedPr = false;
      let worktreeRemoved = false;

      const item = (): ProjectItem => ({
        itemId: 'PVTI_1',
        lane: currentLane,
        issueNumber: 7,
        issueTitle: 'Add feature',
        issueBody: 'Please add it',
        issueUrl: 'https://github.com/your-org/your-repo/issues/7',
        labels: [],
        state: 'OPEN',
      });

      const orchestrator = new TicketOrchestrator({
        config: makeConfig(dir),
        store,
        projects: {
          listItems: async () => [item()],
          moveItemToLane: async (_id, lane) => {
            currentLane = lane;
          },
        } as never,
        issues: {
          listComments: async () => [],
          getNewHumanComments: async (_issue, sinceId) =>
            humanComments.filter((c) => c.id > sinceId),
          postComment: async (issue, body) => {
            commentSeq += 1;
            postedComments.push({ issue, body });
            return commentSeq;
          },
          addLabels: async () => undefined,
          downloadAssets: async () => [],
        } as never,
        prs: {
          findOpenPRByBranch: async () => null,
          createOrGetPR: async () => ({
            number: 55,
            url: 'https://github.com/your-org/your-repo/pull/55',
            headSha: 'sha1',
          }),
          updatePR: async () => {},
          getPR: async () => ({
            number: 55,
            state: mergedPr ? 'closed' : 'open',
            merged: mergedPr,
            head: { sha: 'sha1', ref: 'ticket/7-add-feature' },
            body: 'Automated implementation by OpenCode.\n\nCloses #7',
          }),
          evaluateKiloCodeReview: async () => reviewState,
          mergePR: async () => {
            mergedPr = true;
          },
        } as never,
        worktrees: {
          ensureWorktree: async () => ({
            branchName: 'ticket/7-add-feature',
            worktreePath: join(dir, 'wt-7'),
          }),
          ensureCommittedAndPushed: async () => ({ pushed: true, headSha: 'sha2' }),
          removeWorktree: async () => {
            worktreeRemoved = true;
          },
        } as never,
        opencode: {
          createSession: async () => 'ses_7',
          sendPromptAndWait: async () => opencodeOutcome,
        } as never,
      });

      // 1. Ready -> Needs input
      await orchestrator.pollOnce();
      await orchestrator.waitForIdle();
      assert.equal(currentLane, LANES.NEEDS_INPUT);
      assert.match(postedComments[0].body, /Which color\?/);

      // 2. Human replies -> In review
      humanComments = [
        {
          id: 99,
          author: 'your-username',
          body: 'Use blue',
          createdAt: '2026-11-17T10:01:00Z',
          updatedAt: '2026-11-17T10:01:00Z',
        },
      ];
      opencodeOutcome = {
        status: 'ready_for_review',
        prTitle: 'feat: blue button',
        prSummary: 'Made it blue',
      };
      await orchestrator.pollOnce();
      await orchestrator.waitForIdle();
      assert.equal(currentLane, LANES.IN_REVIEW);
      assert.equal(store.get(7)?.prNumber, 55);

      // 3. In review with Kilo Code findings -> OpenCode fixes & pushes
      await orchestrator.pollOnce();
      await orchestrator.waitForIdle();
      assert.equal(store.get(7)?.reviewIterations, 1);
      assert.equal(mergedPr, false);

      // 4. Kilo Code clean -> Auto-merged & Done
      reviewState = { status: 'clean', summary: 'No Issues Found' };
      await orchestrator.pollOnce();
      await orchestrator.waitForIdle();
      assert.equal(mergedPr, true);
      assert.equal(worktreeRemoved, true);
      assert.equal(currentLane, LANES.DONE);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps manual merge tickets in In review with ready to merge label until merged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orchestrator-manual-test-'));
    const store = new TicketStore(join(dir, 'state.db'));

    try {
      let currentLane: string = LANES.IN_REVIEW;
      const addedLabels: string[] = [];
      let mergedPr = false;
      let mergeCalled = false;

      store.upsert({
        issueNumber: 8,
        projectItemId: 'PVTI_8',
        lane: LANES.IN_REVIEW,
        sessionId: 'ses_8',
        branchName: 'ticket/8-manual',
        worktreePath: join(dir, 'wt-8'),
        prNumber: 56,
        lastCommentId: 0,
        lastPushedAt: '2026-11-17T10:00:00Z',
        reviewIterations: 0,
        manualMergeNotified: 0,
      });

      const orchestrator = new TicketOrchestrator({
        config: makeConfig(dir),
        store,
        projects: {
          listItems: async () => [
            {
              itemId: 'PVTI_8',
              lane: currentLane,
              issueNumber: 8,
              issueTitle: 'Manual merge ticket',
              issueBody: '',
              issueUrl: 'https://github.com/your-org/your-repo/issues/8',
              labels: ['manual merge'],
              state: 'OPEN',
            },
          ],
          moveItemToLane: async (_id, lane) => {
            currentLane = lane;
          },
        } as never,
        issues: {
          postComment: async () => 200,
          addLabels: async (_issue, labels) => {
            addedLabels.push(...labels);
          },
        } as never,
        prs: {
          getPR: async () => ({
            number: 56,
            state: mergedPr ? 'closed' : 'open',
            merged: mergedPr,
            head: { sha: 'sha8', ref: 'ticket/8-manual' },
          }),
          evaluateKiloCodeReview: async () => ({
            status: 'clean',
            summary: 'No Issues Found',
          }),
          mergePR: async () => {
            mergeCalled = true;
          },
        } as never,
        worktrees: {
          removeWorktree: async () => undefined,
        } as never,
        opencode: {} as never,
      });

      // Clean review with manual merge -> stays in In review, adds label, does NOT merge
      await orchestrator.pollOnce();
      await orchestrator.waitForIdle();
      assert.equal(currentLane, LANES.IN_REVIEW);
      assert.equal(mergeCalled, false);
      assert.deepEqual(addedLabels, ['ready to merge']);
      assert.equal(store.get(8)?.manualMergeNotified, 1);

      // User manually merges PR -> moves to Done
      mergedPr = true;
      await orchestrator.pollOnce();
      await orchestrator.waitForIdle();
      assert.equal(currentLane, LANES.DONE);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
