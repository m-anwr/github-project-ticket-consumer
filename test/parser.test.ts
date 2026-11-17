import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractAssetUrls } from '../src/github/issues.ts';
import { parseKiloCodeSummary } from '../src/github/prs.ts';
import { parseTicketStatus } from '../src/opencode/client.ts';

describe('parseTicketStatus', () => {
  it('parses needs_input status', () => {
    const out = parseTicketStatus(`
I checked the codebase and need clarification.
<ticket-status>
{
  "status": "needs_input",
  "question": "Should the button redirect to /settings?"
}
</ticket-status>`);
    assert.equal(out.status, 'needs_input');
    assert.equal(
      out.status === 'needs_input' ? out.question : null,
      'Should the button redirect to /settings?',
    );
    // The agent's own words are kept, without the machine-readable block.
    assert.equal(
      out.status === 'needs_input' ? out.rawText : null,
      'I checked the codebase and need clarification.',
    );
  });

  it('parses ready_for_review status', () => {
    const out = parseTicketStatus(`
All tests pass.
<ticket-status>
{
  "status": "ready_for_review",
  "pr_title": "feat: add profile sections",
  "pr_summary": "Added sections and unit tests."
}
</ticket-status>`);
    assert.equal(out.status, 'ready_for_review');
    assert.equal(
      out.status === 'ready_for_review' ? out.prTitle : null,
      'feat: add profile sections',
    );
    assert.equal(
      out.status === 'ready_for_review' ? out.prSummary : null,
      'Added sections and unit tests.',
    );
    assert.equal(out.status === 'ready_for_review' ? out.rawText : null, 'All tests pass.');
    assert.equal(out.status === 'ready_for_review' ? out.prNumber : null, undefined);
  });

  it('parses the PR number the agent opened, as a number or a string', () => {
    const numeric = parseTicketStatus(`
Done.
<ticket-status>
{ "status": "ready_for_review", "pr_number": 98 }
</ticket-status>`);
    assert.equal(numeric.status === 'ready_for_review' ? numeric.prNumber : null, 98);

    const asString = parseTicketStatus(`
Done.
<ticket-status>
{ "status": "ready_for_review", "pr_number": "98" }
</ticket-status>`);
    assert.equal(asString.status === 'ready_for_review' ? asString.prNumber : null, 98);

    const garbage = parseTicketStatus(`
Done.
<ticket-status>
{ "status": "ready_for_review", "pr_number": "not-a-number" }
</ticket-status>`);
    assert.equal(garbage.status === 'ready_for_review' ? garbage.prNumber : null, undefined);
  });

  it('returns unknown when no tag is present', () => {
    const out = parseTicketStatus('Just some text');
    assert.equal(out.status, 'unknown');
  });
});

describe('extractAssetUrls', () => {
  it('extracts GitHub user-attachments and img src URLs without duplicates', () => {
    const md = `
Here is a screenshot:
![screenshot](https://github.com/user-attachments/assets/abc-123)
<img width="400" src="https://github.com/user-attachments/assets/abc-123" />
And a log file: [log.txt](https://github.com/user-attachments/files/999/log.txt)
Old image: https://user-images.githubusercontent.com/12345/67890.png
`;
    const urls = extractAssetUrls(md);
    assert.deepEqual(urls, [
      'https://github.com/user-attachments/assets/abc-123',
      'https://github.com/user-attachments/files/999/log.txt',
      'https://user-images.githubusercontent.com/12345/67890.png',
    ]);
  });
});

describe('parseKiloCodeSummary', () => {
  it('detects clean review even when previous history had issues', () => {
    const body = `<!-- kilo-review -->

## Code Review Summary

**Status:** No Issues Found | **Recommendation:** Merge

<details>
<summary><b>Files Reviewed (1 file)</b></summary>

- \`fe/app/utils/profile-sections.ts\`

</details>

<!-- kilo-review-history -->
<details>
<summary><b>Previous Review Summaries</b> (2 snapshots, latest commit 54ffaa9)</summary>

### Previous review (commit 54ffaa9)
**Status:** 1 Issue Found | **Recommendation:** Address before merge
</details>`;

    const parsed = parseKiloCodeSummary(body);
    assert.equal(parsed.isClean, true);
  });

  it('detects issues when current status reports issues found', () => {
    const body = `<!-- kilo-review -->

## Code Review Summary

**Status:** 2 Issues Found | **Recommendation:** Address before merge`;

    const parsed = parseKiloCodeSummary(body);
    assert.equal(parsed.isClean, false);
  });
});
