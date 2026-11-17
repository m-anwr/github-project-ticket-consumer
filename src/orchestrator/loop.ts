import { join } from 'node:path';
import type { TicketStore } from '../db/store.ts';
import type { WorktreeManager } from '../git/worktree.ts';
import type { GitHubIssuesClient } from '../github/issues.ts';
import type { GitHubProjectsClient } from '../github/projects.ts';
import type { GitHubPRsClient } from '../github/prs.ts';
import { log } from '../logger.ts';
import type { OpenCodeClient } from '../opencode/client.ts';
import { LANES, type Config, type OpenCodeTicketStatus, type ProjectItem } from '../types.ts';
import {
  buildHumanReplyPrompt,
  buildInitialPrompt,
  buildReviewFindingsPrompt,
} from './prompts.ts';

export interface OrchestratorDeps {
  config: Config;
  store: TicketStore;
  projects: GitHubProjectsClient;
  issues: GitHubIssuesClient;
  prs: GitHubPRsClient;
  worktrees: WorktreeManager;
  opencode: OpenCodeClient;
}

export class TicketOrchestrator {
  private readonly deps: OrchestratorDeps;
  private readonly inFlight = new Set<number>();
  private readonly pendingTasks = new Set<Promise<void>>();

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
  }

  private pollCount = 0;

  async pollOnce(): Promise<void> {
    this.pollCount += 1;
    const items = await this.deps.projects.listItems();
    const openItems = items.filter((i) => i.state === 'OPEN');

    if (this.pollCount % 4 === 1 || this.inFlight.size > 0) {
      const counts = new Map<string, number>();
      for (const item of openItems) {
        counts.set(item.lane, (counts.get(item.lane) || 0) + 1);
      }
      const summary = [...counts.entries()].map(([lane, n]) => `${lane}:${n}`).join(', ');
      log.info(
        'poll',
        `#${this.pollCount} (${openItems.length} open: ${summary || 'none'}; inFlight: ${
          this.inFlight.size > 0 ? [...this.inFlight].map((n) => `#${n}`).join(',') : 'none'
        })`,
      );
    }

    for (const item of openItems) {
      if (this.inFlight.has(item.issueNumber)) continue;

      if (item.lane === LANES.READY) {
        this.launchBackground(item.issueNumber, () => this.handleReady(item));
      } else if (item.lane === LANES.NEEDS_INPUT) {
        this.launchBackground(item.issueNumber, () => this.handleNeedsInput(item));
      } else if (item.lane === LANES.IN_REVIEW) {
        this.launchBackground(item.issueNumber, () => this.handleInReview(item));
      } else if (item.lane === LANES.IN_PROGRESS) {
        const record = this.deps.store.get(item.issueNumber);
        if (record?.prNumber && record.lane === LANES.IN_REVIEW) {
          this.launchBackground(item.issueNumber, async () => {
            console.log(`[reconcile] Moving #${item.issueNumber} from In progress to In review (PR #${record.prNumber})`);
            await this.deps.projects.moveItemToLane(item.itemId, LANES.IN_REVIEW);
          });
        }
      }
    }
  }

  async waitForIdle(): Promise<void> {
    if (this.pendingTasks.size > 0) {
      await Promise.allSettled([...this.pendingTasks]);
    }
  }

  private launchBackground(issueNumber: number, fn: () => Promise<void>): void {
    this.inFlight.add(issueNumber);
    const task = fn()
      .catch((err) => {
        console.error(`[orchestrator] Unhandled error for #${issueNumber}:`, err);
      })
      .finally(() => {
        this.inFlight.delete(issueNumber);
        this.pendingTasks.delete(task);
      });
    this.pendingTasks.add(task);
  }

  async handleReady(item: ProjectItem): Promise<void> {
    const { config, store, projects, issues, worktrees, opencode } = this.deps;
    console.log(`[ready] Picking up #${item.issueNumber}: ${item.issueTitle}`);

    const { branchName, worktreePath } = await worktrees.ensureWorktree(
      item.issueNumber,
      item.issueTitle,
    );

    const existingComments = await issues.listComments(item.issueNumber);
    const latestCommentId = existingComments.at(-1)?.id ?? 0;

    let record = store.get(item.issueNumber);
    const sessionId =
      record?.sessionId ||
      (await opencode.createSession(worktreePath, `Issue #${item.issueNumber}: ${item.issueTitle}`));

    record = store.upsert({
      issueNumber: item.issueNumber,
      projectItemId: item.itemId,
      lane: LANES.IN_PROGRESS,
      sessionId,
      branchName,
      worktreePath,
      prNumber: record?.prNumber ?? null,
      lastCommentId: Math.max(record?.lastCommentId ?? 0, latestCommentId),
      lastPushedAt: record?.lastPushedAt ?? null,
      reviewIterations: record?.reviewIterations ?? 0,
      manualMergeNotified: record?.manualMergeNotified ?? 0,
    });

    await projects.moveItemToLane(item.itemId, LANES.IN_PROGRESS);

    try {
      const assetsDir = join(config.dataDir, 'assets', `issue-${item.issueNumber}`);
      const assets = await issues.downloadAssets(item.issueBody, assetsDir);
      const prompt = buildInitialPrompt(item, branchName, assets);
      const outcome = await opencode.sendPromptAndWait(sessionId, worktreePath, prompt, assets);
      await this.handleBuildOutcome(item, sessionId, worktreePath, branchName, outcome);
    } catch (err) {
      await this.escalateError(item, err);
    }
  }

  async handleNeedsInput(item: ProjectItem): Promise<void> {
    const { config, store, projects, issues, worktrees, opencode } = this.deps;
    const record = store.get(item.issueNumber);
    if (!record) return;

    const newComments = await issues.getNewHumanComments(
      item.issueNumber,
      record.lastCommentId,
      config.githubAllowedAuthors,
    );
    if (newComments.length === 0) return;

    console.log(`[needs-input] Resuming #${item.issueNumber} with ${newComments.length} new comment(s)`);
    const latestCommentId = newComments.at(-1)!.id;

    const { branchName, worktreePath } =
      record.worktreePath && record.branchName
        ? { branchName: record.branchName, worktreePath: record.worktreePath }
        : await worktrees.ensureWorktree(item.issueNumber, item.issueTitle);

    const sessionId =
      record.sessionId ||
      (await opencode.createSession(worktreePath, `Issue #${item.issueNumber}: ${item.issueTitle}`));

    store.patch(item.issueNumber, {
      lane: LANES.IN_PROGRESS,
      sessionId,
      branchName,
      worktreePath,
      lastCommentId: latestCommentId,
    });
    await projects.moveItemToLane(item.itemId, LANES.IN_PROGRESS);

    try {
      const assetsDir = join(config.dataDir, 'assets', `issue-${item.issueNumber}`);
      const combinedMarkdown = newComments.map((c) => c.body).join('\n');
      const assets = await issues.downloadAssets(combinedMarkdown, assetsDir);
      const prompt = buildHumanReplyPrompt(newComments, assets);
      const outcome = await opencode.sendPromptAndWait(sessionId, worktreePath, prompt, assets);
      await this.handleBuildOutcome(item, sessionId, worktreePath, branchName, outcome);
    } catch (err) {
      await this.escalateError(item, err);
    }
  }

  async handleInReview(item: ProjectItem): Promise<void> {
    const { config, store, projects, issues, prs, worktrees, opencode } = this.deps;
    const record = store.get(item.issueNumber);
    if (!record?.prNumber || !record.branchName || !record.worktreePath) return;

    const pr = await prs.getPR(record.prNumber);
    if (pr.merged) {
      console.log(`[in-review] PR #${pr.number} for #${item.issueNumber} was merged; moving to Done`);
      await worktrees.removeWorktree(record.worktreePath, record.branchName);
      await projects.moveItemToLane(item.itemId, LANES.DONE);
      store.patch(item.issueNumber, { lane: LANES.DONE });
      return;
    }

    if (pr.state === 'closed') {
      return;
    }

    const review = await prs.evaluateKiloCodeReview({
      prNumber: pr.number,
      headSha: pr.head.sha,
      reviewBotLogins: config.reviewBotLogins,
      reviewCheckName: config.reviewCheckName,
      requireAllChecks: config.requireAllChecks,
      lastPushedAt: record.lastPushedAt,
    });

    if (review.status === 'pending') {
      log.info('in-review', `#${item.issueNumber} PR #${pr.number}: ${review.reason}`);
      return;
    }

    if (review.status === 'has_findings') {
      log.info(
        'in-review',
        `#${item.issueNumber} PR #${pr.number} has findings (${review.inlineComments.length} inline, iteration ${record.reviewIterations + 1}/${config.maxReviewIterations})`,
      );
      if (record.reviewIterations >= config.maxReviewIterations) {
        console.warn(`[in-review] #${item.issueNumber} reached max review iterations (${config.maxReviewIterations})`);
        const commentId = await issues.postComment(
          item.issueNumber,
          `Reached maximum automated review-fix iterations (${config.maxReviewIterations}) on PR #${pr.number}. Moving to **Needs input** for manual review.`,
        );
        store.patch(item.issueNumber, { lane: LANES.NEEDS_INPUT, lastCommentId: commentId });
        await projects.moveItemToLane(item.itemId, LANES.NEEDS_INPUT);
        return;
      }

      console.log(`[in-review] Sending Kilo Code findings for PR #${pr.number} (issue #${item.issueNumber}) to OpenCode`);
      const sessionId =
        record.sessionId ||
        (await opencode.createSession(
          record.worktreePath,
          `Issue #${item.issueNumber}: ${item.issueTitle}`,
        ));

      const prompt = buildReviewFindingsPrompt(pr.number, review.summary, review.inlineComments);
      await opencode.sendPromptAndWait(sessionId, record.worktreePath, prompt);

      await worktrees.ensureCommittedAndPushed(
        record.worktreePath,
        record.branchName,
        `fix: address review feedback for #${item.issueNumber}`,
      );

      store.patch(item.issueNumber, {
        sessionId,
        reviewIterations: record.reviewIterations + 1,
        lastPushedAt: new Date().toISOString(),
      });
      return;
    }

    // review.status === 'clean'
    const hasManualMerge = item.labels.some(
      (l) => l.toLowerCase() === config.manualMergeLabel.toLowerCase(),
    );

    if (hasManualMerge) {
      if (config.manualMergeBehavior === 'move_to_done') {
        if (!record.manualMergeNotified) {
          const commentId = await issues.postComment(
            item.issueNumber,
            `PR #${pr.number} passed Kilo Code review with no issues. Leaving open for manual merge (\`${config.manualMergeLabel}\` label present) and moving ticket to **Done**.`,
          );
          store.patch(item.issueNumber, {
            lane: LANES.DONE,
            lastCommentId: commentId,
            manualMergeNotified: 1,
          });
        } else {
          store.patch(item.issueNumber, { lane: LANES.DONE });
        }
        await worktrees.removeWorktree(record.worktreePath, record.branchName);
        await projects.moveItemToLane(item.itemId, LANES.DONE);
        return;
      }

      // Option A (keep_in_review): label as ready to merge and wait for user to merge PR
      if (!record.manualMergeNotified) {
        console.log(`[in-review] PR #${pr.number} is clean and has "${config.manualMergeLabel}"; marking ready to merge`);
        await issues.addLabels(item.issueNumber, [config.readyToMergeLabel]);
        const commentId = await issues.postComment(
          item.issueNumber,
          `PR #${pr.number} passed Kilo Code review with no issues and is **ready to merge** manually.`,
        );
        store.patch(item.issueNumber, {
          lastCommentId: commentId,
          manualMergeNotified: 1,
        });
      }
      return;
    }

    console.log(`[in-review] Auto-merging PR #${pr.number} for #${item.issueNumber}`);
    await prs.mergePR(pr.number, config.autoMergeMethod, record.branchName);
    await worktrees.removeWorktree(record.worktreePath, record.branchName);
    await issues.postComment(
      item.issueNumber,
      `PR #${pr.number} passed Kilo Code review and was auto-merged (${config.autoMergeMethod}).`,
    );
    await projects.moveItemToLane(item.itemId, LANES.DONE);
    store.patch(item.issueNumber, { lane: LANES.DONE });
  }

  private async handleBuildOutcome(
    item: ProjectItem,
    sessionId: string,
    worktreePath: string,
    branchName: string,
    outcome: OpenCodeTicketStatus,
  ): Promise<void> {
    const { store, projects, issues, prs, worktrees } = this.deps;

    if (outcome.status === 'needs_input') {
      console.log(`[in-progress] #${item.issueNumber} needs input`);
      const commentId = await issues.postComment(
        item.issueNumber,
        `**OpenCode needs input:**\n\n${outcome.question}`,
      );
      store.patch(item.issueNumber, {
        lane: LANES.NEEDS_INPUT,
        sessionId,
        lastCommentId: commentId,
      });
      await projects.moveItemToLane(item.itemId, LANES.NEEDS_INPUT);
      return;
    }

    // ready_for_review or unknown -> verify committed & pushed, then open PR
    const { pushed } = await worktrees.ensureCommittedAndPushed(
      worktreePath,
      branchName,
      `feat: resolve #${item.issueNumber} - ${item.issueTitle}`,
    );

    const prTitle =
      outcome.status === 'ready_for_review' && outcome.prTitle
        ? outcome.prTitle
        : item.issueTitle;
    const prSummary =
      outcome.status === 'ready_for_review' && outcome.prSummary
        ? outcome.prSummary
        : 'Automated implementation by OpenCode.';

    const pr = await prs.createOrGetPR(
      branchName,
      this.deps.config.baseBranch,
      prTitle,
      `${prSummary}\n\nCloses #${item.issueNumber}`,
    );

    console.log(`[in-progress] Opened/updated PR #${pr.number} (${pr.url}) for #${item.issueNumber}`);
    store.patch(item.issueNumber, {
      lane: LANES.IN_REVIEW,
      sessionId,
      prNumber: pr.number,
      lastPushedAt: pushed ? new Date().toISOString() : new Date().toISOString(),
    });
    await projects.moveItemToLane(item.itemId, LANES.IN_REVIEW);
  }

  private async escalateError(item: ProjectItem, err: unknown): Promise<void> {
    const { store, projects, issues } = this.deps;
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[error] #${item.issueNumber} failed:`, message);

    const commentId = await issues.postComment(
      item.issueNumber,
      `OpenCode encountered an error while working on this ticket:\n\`\`\`\n${message}\n\`\`\`\nMoving to **Needs input**—reply here to retry or provide guidance.`,
    );
    store.patch(item.issueNumber, {
      lane: LANES.NEEDS_INPUT,
      lastCommentId: commentId,
    });
    await projects.moveItemToLane(item.itemId, LANES.NEEDS_INPUT);
  }
}
