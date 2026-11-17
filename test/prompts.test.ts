import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ghCliStatus } from '../src/ghcli.ts';
import {
  buildHumanReplyPrompt,
  buildInitialPrompt,
  buildPrBody,
  buildReviewFindingsPrompt,
  type PromptContext,
} from '../src/orchestrator/prompts.ts';
import type { InlineReviewComment, IssueComment, ProjectItem } from '../src/types.ts';

/**
 * `COMMENT_DELIVERY` decides how a review finding or a human reply reaches the
 * agent:
 *
 *   agent  - the prompt names the repository and the comment ids, and the
 *            agent fetches the comments itself with `gh`. The agent sees the
 *            real comment instead of a transcription, and the prompt stays
 *            small.
 *   inline - the daemon quotes the comment bodies and diff hunks into the
 *            prompt. Self-contained, but it re-serialises what the agent could
 *            read directly from its own working tree.
 *
 * The selection of WHICH comments are in scope stays with the daemon in both
 * modes -- that is what stops a later round from re-fixing an earlier round's
 * findings.
 */

const INLINE: InlineReviewComment = {
  id: 4242,
  author: 'kilo-code-bot[bot]',
  path: 'fe/app/components/landing/LandingSetupForm.vue',
  line: 165,
  diffHunk: '@@ -160,6 +160,14 @@\n-    if (LANDING_CONFIG.formEndpoint) {',
  body: 'Empty endpoint logs lead data locally but reports success without delivering the lead.',
  commitId: 'abc123',
  createdAt: '2026-11-17T12:00:00Z',
};

const REPLY: IssueComment = {
  id: 777,
  author: 'm-anwr',
  body: 'Use the real WhatsApp number from the config and do not fake the success message.',
  createdAt: '2026-11-17T12:00:00Z',
  updatedAt: '2026-11-17T12:00:00Z',
};

function ctx(mode: 'agent' | 'inline', overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    mode,
    owner: 'm-anwr',
    repo: 'tabooor-monorepo',
    issueNumber: 97,
    branchName: 'ticket/97-create-landing-page',
    baseBranch: 'master',
    prBodyPath: '/var/lib/consumer/pr-bodies/issue-97.md',
    prOpening: 'agent',
    ghAvailable: true,
    ...overrides,
  };
}

const REVIEW_OPTS = {
  headSha: 'abc123',
  botLogin: 'kilo-code-bot[bot]',
  summaryCommentId: 999,
  inlineComments: [INLINE],
  summary: '**Status:** 1 Issues Found',
};

describe('buildReviewFindingsPrompt', () => {
  it('agent mode: points the agent at the comments instead of quoting them', () => {
    const prompt = buildReviewFindingsPrompt(98, ctx('agent'), REVIEW_OPTS);

    assert.match(prompt, /gh api repos\/m-anwr\/tabooor-monorepo\/pulls\/98\/comments/);
    assert.match(prompt, /gh api repos\/m-anwr\/tabooor-monorepo\/issues\/98\/comments/);
    // the identifiers are in scope
    assert.match(prompt, /4242/);
    assert.match(prompt, /999/);
    assert.match(prompt, /abc123/);
    // but the content is NOT transcribed
    assert.doesNotMatch(prompt, /Empty endpoint logs lead data locally/);
    assert.doesNotMatch(prompt, /LANDING_CONFIG\.formEndpoint/);
    // and it tells the agent to stop rather than guess if gh is missing
    assert.match(prompt, /unavailable or unauthenticated, say so and stop/);
    // the status contract is still there
    assert.match(prompt, /<ticket-status>/);
  });

  it('inline mode: keeps quoting the comment body and diff hunk', () => {
    const prompt = buildReviewFindingsPrompt(98, ctx('inline'), REVIEW_OPTS);

    assert.match(prompt, /Empty endpoint logs lead data locally/);
    assert.match(prompt, /LANDING_CONFIG\.formEndpoint/);
    assert.match(prompt, /### Finding 1: `fe\/app\/components\/landing\/LandingSetupForm\.vue`/);
    assert.match(prompt, /<ticket-status>/);
  });

  it('does not tell the agent to run gh when it has no gh', () => {
    const prompt = buildReviewFindingsPrompt(
      98,
      ctx('inline', { ghAvailable: false }),
      REVIEW_OPTS,
    );
    assert.doesNotMatch(prompt, /gh pr edit/);
    // but it still tells it where to push
    assert.match(prompt, /Push your fixes to that branch/);
  });

  it('agent mode does not grow with the size of the findings', () => {
    // The agent prompt carries fixed instructions and identifiers, not content,
    // so a bigger review must not make it bigger. The inline prompt carries
    // every hunk and body, so it grows linearly with the review.
    const small = buildReviewFindingsPrompt(98, ctx('agent'), REVIEW_OPTS);
    const big = buildReviewFindingsPrompt(98, ctx('agent'), {
      ...REVIEW_OPTS,
      inlineComments: [
        { ...INLINE, diffHunk: 'x'.repeat(20_000), body: 'y'.repeat(5_000) },
      ],
    });
    assert.ok(
      big.length - small.length < 500,
      `agent prompt grew by ${big.length - small.length} chars with the content`,
    );

    const inlineBig = buildReviewFindingsPrompt(98, ctx('inline'), {
      ...REVIEW_OPTS,
      inlineComments: [
        { ...INLINE, diffHunk: 'x'.repeat(20_000), body: 'y'.repeat(5_000) },
      ],
    });
    assert.ok(
      inlineBig.length > 25_000,
      `inline prompt should carry the content (${inlineBig.length} chars)`,
    );
  });
});

describe('buildHumanReplyPrompt', () => {
  it('agent mode: gives the comment id and the fetch command, not the body', () => {
    const prompt = buildHumanReplyPrompt([REPLY], [], ctx('agent'));

    assert.match(prompt, /gh api repos\/m-anwr\/tabooor-monorepo\/issues\/97\/comments/);
    assert.match(prompt, /777/);
    assert.doesNotMatch(prompt, /Use the real WhatsApp number from the config/);
    assert.match(prompt, /unavailable or unauthenticated, say so and stop/);
    assert.match(prompt, /<ticket-status>/);
  });

  it('inline mode: keeps quoting the comment body', () => {
    const prompt = buildHumanReplyPrompt([REPLY], [], ctx('inline'));
    assert.match(prompt, /Comment by @m-anwr/);
    assert.match(prompt, /Use the real WhatsApp number from the config/);
    assert.match(prompt, /<ticket-status>/);
  });
});

const ITEM: ProjectItem = {
  itemId: 'PVTI_1',
  lane: 'Ready',
  issueNumber: 97,
  issueTitle: 'Create landing page for social media ads',
  issueBody: 'Build the clinics landing page.',
  issueUrl: 'https://github.com/m-anwr/tabooor-monorepo/issues/97',
  labels: ['feature'],
  state: 'OPEN',
};

describe('buildInitialPrompt', () => {
  it('agent mode: asks the agent to open the pull request itself', () => {
    const prompt = buildInitialPrompt(ITEM, [], ctx('agent'));

    assert.match(prompt, /gh pr create --base master --head ticket\/97-create-landing-page/);
    assert.match(prompt, /--body-file \/var\/lib\/consumer\/pr-bodies\/issue-97\.md/);
    // the description has to say what changed, how it was verified, and what
    // is still open
    assert.match(prompt, /what changed, how you verified it/);
    assert.match(prompt, /anything still open/);
    // and it has to close the issue
    assert.match(prompt, /Closes #97/);
    // the status contract can carry the number it opened
    assert.match(prompt, /"pr_number": 123/);
  });

  it('daemon mode: does not ask the agent to open the pull request', () => {
    const prompt = buildInitialPrompt(ITEM, [], ctx('agent', { prOpening: 'daemon' }));
    assert.doesNotMatch(prompt, /gh pr create/);
    // but the agent still has to commit and push
    assert.match(prompt, /push the branch to origin/);
  });
});

describe('buildPrBody', () => {
  it('uses the agent\'s own report, not just the summary', () => {
    const body = buildPrBody(
      {
        status: 'ready_for_review',
        prTitle: 'feat: add landing page',
        prSummary: 'A one-line summary.',
        rawText: `## What shipped
The clinics landing page.

## Verified
scoped ESLint clean, nuxt typecheck clean, build succeeded.

## Still open
The WhatsApp number is a placeholder.`,
      },
      97,
    );

    assert.match(body, /## Verified/);
    assert.match(body, /scoped ESLint clean/);
    assert.match(body, /The WhatsApp number is a placeholder/);
    assert.match(body, /Closes #97/);
  });

  it('falls back to the summary, then to a placeholder', () => {
    const fromSummary = buildPrBody(
      { status: 'ready_for_review', prSummary: 'A one-line summary.' },
      97,
    );
    assert.match(fromSummary, /A one-line summary\./);
    assert.match(fromSummary, /Closes #97/);

    const fallback = buildPrBody({ status: 'unknown', rawText: 'some text' }, 97);
    assert.match(fallback, /some text/);
    assert.match(fallback, /Closes #97/);
  });
});

describe('ghCliStatus', () => {
  it('reports the CLI as unusable when it is not on PATH', () => {
    const status = ghCliStatus({ PATH: '/nonexistent-directory-for-tests' });
    assert.equal(status.available, false);
    assert.equal(status.usable, false);
    assert.match(status.detail, /not found/);
  });

  it('reports a consistent shape whatever the environment', () => {
    const status = ghCliStatus();
    assert.equal(typeof status.available, 'boolean');
    assert.equal(typeof status.authenticated, 'boolean');
    assert.equal(typeof status.usable, 'boolean');
    assert.equal(status.usable, status.available && status.authenticated);
    assert.ok(status.detail.length > 0);
  });
});
