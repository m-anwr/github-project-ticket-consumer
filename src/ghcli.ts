import { execFileSync } from 'node:child_process';

export interface GhCliStatus {
  /** The `gh` binary is on PATH. */
  available: boolean;
  /** `gh` has a usable credential for github.com. */
  authenticated: boolean;
  /** The agent can actually fetch comments with it. */
  usable: boolean;
  /** Human-readable summary for the startup log. */
  detail: string;
}

/**
 * Probe the `gh` CLI.
 *
 * This exists because of the `COMMENT_DELIVERY=agent` mode: the daemon then
 * asks the AGENT to fetch the review comments itself instead of quoting them
 * into the prompt. That only works if the agent can run `gh`, so the daemon
 * checks up front and falls back to quoting the comments inline when it
 * cannot.
 *
 * The check runs in the DAEMON's environment, which is a proxy for the
 * agent's: both run as the same user on the same host, and both get `HOME`
 * and a PATH containing `/usr/bin`. The prompt also tells the agent to stop
 * and report if `gh` turns out to be unusable for it, so a mismatch between
 * the two environments still fails loudly instead of silently.
 */
export function ghCliStatus(env: NodeJS.ProcessEnv = process.env): GhCliStatus {
  let version: string;
  try {
    version =
      execFileSync('gh', ['--version'], { encoding: 'utf8', timeout: 10_000, env })
        .split('\n')[0]
        ?.trim() || 'gh';
  } catch {
    return {
      available: false,
      authenticated: false,
      usable: false,
      detail: 'gh CLI not found on PATH',
    };
  }

  try {
    const auth = execFileSync('gh', ['auth', 'status'], {
      encoding: 'utf8',
      timeout: 15_000,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const account = /account (\S+)/.exec(auth)?.[1] ?? 'unknown';
    return {
      available: true,
      authenticated: true,
      usable: true,
      detail: `${version} (${account})`,
    };
  } catch {
    return {
      available: true,
      authenticated: false,
      usable: false,
      detail: `${version}, not authenticated`,
    };
  }
}
