import { execFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout.trim();
}

export function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'task';
}

export class WorktreeManager {
  private readonly repoPath: string;
  private readonly baseBranch: string;
  private readonly worktreesDir: string;

  constructor(repoPath: string, baseBranch: string, dataDir: string) {
    this.repoPath = repoPath;
    this.baseBranch = baseBranch;
    this.worktreesDir = join(dataDir, 'worktrees');
    mkdirSync(this.worktreesDir, { recursive: true });
  }

  async ensureWorktree(
    issueNumber: number,
    title: string,
  ): Promise<{ branchName: string; worktreePath: string }> {
    const branchName = `ticket/${issueNumber}-${slugifyTitle(title)}`;
    const worktreePath = join(this.worktreesDir, `issue-${issueNumber}`);

    await runGit(this.repoPath, ['fetch', 'origin', this.baseBranch]);

    if (existsSync(worktreePath)) {
      return { branchName, worktreePath };
    }

    const branchExists = await runGit(this.repoPath, ['branch', '--list', branchName]);
    if (branchExists) {
      await runGit(this.repoPath, ['worktree', 'add', worktreePath, branchName]);
    } else {
      await runGit(this.repoPath, [
        'worktree',
        'add',
        '-b',
        branchName,
        worktreePath,
        `origin/${this.baseBranch}`,
      ]);
    }

    return { branchName, worktreePath };
  }

  /**
   * Safety net: if OpenCode edited files without committing/pushing, commit and push them.
   * Returns true if a push occurred or the remote branch is ahead/up-to-date.
   */
  async ensureCommittedAndPushed(
    worktreePath: string,
    branchName: string,
    commitMessage: string,
  ): Promise<{ pushed: boolean; headSha: string }> {
    const status = await runGit(worktreePath, ['status', '--porcelain']);
    let didCommit = false;
    if (status.length > 0) {
      await runGit(worktreePath, ['add', '-A']);
      await runGit(worktreePath, ['commit', '-m', commitMessage]);
      didCommit = true;
    }

    const headSha = await runGit(worktreePath, ['rev-parse', 'HEAD']);
    const baseSha = await runGit(worktreePath, ['rev-parse', `origin/${this.baseBranch}`]);
    if (headSha === baseSha) {
      return { pushed: false, headSha };
    }

    let remoteSha = '';
    try {
      remoteSha = await runGit(worktreePath, ['rev-parse', `origin/${branchName}`]);
    } catch {
      remoteSha = '';
    }

    if (didCommit || headSha !== remoteSha) {
      await runGit(worktreePath, ['push', '-u', 'origin', branchName]);
      return { pushed: true, headSha };
    }

    return { pushed: false, headSha };
  }

  async removeWorktree(worktreePath: string | null, branchName: string | null): Promise<void> {
    if (worktreePath && existsSync(worktreePath)) {
      try {
        await runGit(this.repoPath, ['worktree', 'remove', '--force', worktreePath]);
      } catch {
        // Fallback if already pruned
      }
    }
    await runGit(this.repoPath, ['worktree', 'prune']).catch(() => undefined);
    if (branchName) {
      await runGit(this.repoPath, ['branch', '-D', branchName]).catch(() => undefined);
    }
  }
}
