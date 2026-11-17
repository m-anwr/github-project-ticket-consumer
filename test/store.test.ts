import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { TicketStore } from '../src/db/store.ts';
import { LANES } from '../src/types.ts';

describe('TicketStore', () => {
  it('upserts, retrieves, and patches ticket records', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ticket-store-test-'));
    try {
      const store = new TicketStore(join(dir, 'state.db'));
      assert.equal(store.get(42), null);

      const created = store.upsert({
        issueNumber: 42,
        projectItemId: 'PVTI_123',
        lane: LANES.IN_PROGRESS,
        sessionId: 'ses_1',
        branchName: 'ticket/42-fix-bug',
        worktreePath: '/tmp/wt-42',
        prNumber: null,
        lastCommentId: 100,
        lastPushedAt: null,
        reviewIterations: 0,
        manualMergeNotified: 0,
      });
      assert.equal(created.issueNumber, 42);
      assert.equal(created.sessionId, 'ses_1');

      const patched = store.patch(42, {
        lane: LANES.IN_REVIEW,
        prNumber: 91,
        reviewIterations: 1,
      });
      assert.equal(patched.lane, LANES.IN_REVIEW);
      assert.equal(patched.prNumber, 91);
      assert.equal(patched.reviewIterations, 1);
      assert.equal(patched.sessionId, 'ses_1');

      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
