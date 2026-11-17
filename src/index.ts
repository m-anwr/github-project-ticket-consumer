import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { TicketStore } from './db/store.ts';
import { ghCliStatus } from './ghcli.ts';
import { WorktreeManager } from './git/worktree.ts';
import { GitHubClient } from './github/client.ts';
import { GitHubIssuesClient } from './github/issues.ts';
import { GitHubProjectsClient } from './github/projects.ts';
import { GitHubPRsClient } from './github/prs.ts';
import { OpenCodeClient } from './opencode/client.ts';
import { TicketOrchestrator } from './orchestrator/loop.ts';

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new TicketStore(join(config.dataDir, 'state.db'));
  const gh = new GitHubClient(config.githubToken);
  const projects = new GitHubProjectsClient(
    gh,
    config.githubOwner,
    config.githubRepo,
    config.githubProjectNumber,
  );
  const issues = new GitHubIssuesClient(gh, config.githubOwner, config.githubRepo);
  const prs = new GitHubPRsClient(gh, config.githubOwner, config.githubRepo);
  const worktrees = new WorktreeManager(config.repoLocalPath, config.baseBranch, config.dataDir);
  const opencode = new OpenCodeClient({
    serverUrl: config.opencodeServerUrl,
    providerId: config.opencodeProviderId,
    modelId: config.opencodeModelId,
    username: config.opencodeServerUsername,
    password: config.opencodeServerPassword,
    messageTimeoutMs: config.opencodeMessageTimeoutMs,
  });

  await projects.init();
  console.log(
    `[startup] Connected to GitHub Project #${config.githubProjectNumber} (${config.githubOwner}/${config.githubRepo})`,
  );
  console.log(
    `[startup] OpenCode=${config.opencodeServerUrl} model=${config.opencodeProviderId}/${config.opencodeModelId} poll=${config.pollIntervalMs}ms manualMerge=${config.manualMergeBehavior}`,
  );

  // `COMMENT_DELIVERY=agent` asks the AGENT to fetch the comments itself with
  // the `gh` CLI instead of the daemon quoting them into the prompt, and
  // `PR_OPENING=agent` asks it to open the pull request with `gh pr create`.
  // Check the CLI up front and fall back to the daemon doing both when it is
  // not usable -- otherwise every review round would fail on the fetch.
  const ghCli = ghCliStatus();
  if (config.commentDelivery === 'agent' && !ghCli.usable) {
    console.warn(
      `[startup] COMMENT_DELIVERY=agent needs the gh CLI in the agent's environment, but ${ghCli.detail}. Falling back to COMMENT_DELIVERY=inline.`,
    );
    config.commentDelivery = 'inline';
  }
  if (config.prOpening === 'agent' && !ghCli.usable) {
    console.warn(
      `[startup] PR_OPENING=agent needs the gh CLI in the agent's environment, but ${ghCli.detail}. Falling back to PR_OPENING=daemon.`,
    );
    config.prOpening = 'daemon';
  }
  config.ghAvailable = ghCli.usable;
  console.log(
    `[startup] commentDelivery=${config.commentDelivery} prOpening=${config.prOpening} gh=${ghCli.detail}`,
  );

  // Where the agent writes the pull request description. Outside the
  // repository, so it cannot end up in the diff.
  mkdirSync(join(config.dataDir, 'pr-bodies'), { recursive: true });

  const orchestrator = new TicketOrchestrator({
    config,
    store,
    projects,
    issues,
    prs,
    worktrees,
    opencode,
  });

  let stopping = false;
  let timer: NodeJS.Timeout | null = null;

  const shutdown = async (signal: string) => {
    if (stopping) {
      console.log(`[shutdown] Received ${signal} again, forcing immediate exit.`);
      store.close();
      process.exit(1);
    }
    stopping = true;
    console.log(`[shutdown] Received ${signal}, waiting for active tasks (press Ctrl+C again to force)...`);
    if (timer) clearTimeout(timer);
    await orchestrator.waitForIdle();
    store.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  const tick = async () => {
    if (stopping) return;
    try {
      await orchestrator.pollOnce();
    } catch (err) {
      console.error('[poll] Error during poll cycle:', err);
    }
    if (!stopping) {
      timer = setTimeout(() => void tick(), config.pollIntervalMs);
    }
  };

  await tick();
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
