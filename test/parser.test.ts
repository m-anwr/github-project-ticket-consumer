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
    assert.deepEqual(out, {
      status: 'needs_input',
      question: 'Should the button redirect to /settings?',
    });
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
    assert.deepEqual(out, {
      status: 'ready_for_review',
      prTitle: 'feat: add profile sections',
      prSummary: 'Added sections and unit tests.',
    });
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
