import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CommentDeliveryMode, Config, ManualMergeBehavior, MergeMethod } from './types.ts';

function requireEnv(env: NodeJS.ProcessEnv, key: string): string {
  const val = env[key]?.trim();
  if (!val) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return val;
}

function parseCsv(val: string | undefined, fallback: string[]): string[] {
  if (!val?.trim()) return fallback;
  return val
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parsePositiveInt(val: string | undefined, fallback: number, key: string): number {
  if (!val?.trim()) return fallback;
  const parsed = Number.parseInt(val, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Environment variable ${key} must be a positive integer, got "${val}"`);
  }
  return parsed;
}

/** Like parsePositiveInt, but 0 is allowed and means "no timeout". */
function parseNonNegativeInt(val: string | undefined, fallback: number, key: string): number {
  if (!val?.trim()) return fallback;
  const parsed = Number.parseInt(val, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Environment variable ${key} must be a non-negative integer, got "${val}"`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const envFile = resolve(process.cwd(), '.env');
  if (env === process.env && existsSync(envFile) && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(envFile);
  }

  const autoMergeMethod = (env.AUTO_MERGE_METHOD?.trim() || 'squash') as MergeMethod;
  if (!['squash', 'merge', 'rebase'].includes(autoMergeMethod)) {
    throw new Error(`Invalid AUTO_MERGE_METHOD: ${autoMergeMethod}`);
  }

  const manualMergeBehavior = (env.MANUAL_MERGE_BEHAVIOR?.trim() ||
    'keep_in_review') as ManualMergeBehavior;
  if (!['keep_in_review', 'move_to_done'].includes(manualMergeBehavior)) {
    throw new Error(`Invalid MANUAL_MERGE_BEHAVIOR: ${manualMergeBehavior}`);
  }

  const commentDelivery = (env.COMMENT_DELIVERY?.trim() || 'agent') as CommentDeliveryMode;
  if (!['agent', 'inline'].includes(commentDelivery)) {
    throw new Error(`Invalid COMMENT_DELIVERY: ${commentDelivery}`);
  }

  const githubOwner = requireEnv(env, 'GITHUB_OWNER');

  return {
    githubToken: requireEnv(env, 'GITHUB_TOKEN'),
    githubOwner,
    githubRepo: requireEnv(env, 'GITHUB_REPO'),
    githubProjectNumber: parsePositiveInt(env.GITHUB_PROJECT_NUMBER, 0, 'GITHUB_PROJECT_NUMBER') ||
      (() => {
        throw new Error('Missing required environment variable: GITHUB_PROJECT_NUMBER');
      })(),
    githubAllowedAuthors: parseCsv(env.GITHUB_ALLOWED_AUTHORS, [githubOwner, 'MennaCC']),
    reviewBotLogins: parseCsv(env.REVIEW_BOT_LOGINS, ['kilo-code-bot[bot]']),
    reviewCheckName: env.REVIEW_CHECK_NAME?.trim() || 'Kilo Code Review',
    requireAllChecks: env.REQUIRE_ALL_CHECKS?.trim().toLowerCase() !== 'false',
    opencodeServerUrl: (env.OPENCODE_SERVER_URL?.trim() || 'http://127.0.0.1:4096').replace(/\/+$/, ''),
    opencodeProviderId: requireEnv(env, 'OPENCODE_PROVIDER_ID'),
    opencodeModelId: requireEnv(env, 'OPENCODE_MODEL_ID'),
    opencodeServerPassword: env.OPENCODE_SERVER_PASSWORD?.trim() || undefined,
    opencodeServerUsername: env.OPENCODE_SERVER_USERNAME?.trim() || 'opencode',
    opencodeMessageTimeoutMs: parseNonNegativeInt(
      env.OPENCODE_MESSAGE_TIMEOUT_MS,
      0,
      'OPENCODE_MESSAGE_TIMEOUT_MS',
    ),
    repoLocalPath: resolve(requireEnv(env, 'REPO_LOCAL_PATH')),
    baseBranch: env.BASE_BRANCH?.trim() || 'main',
    dataDir: resolve(env.DATA_DIR?.trim() || './data'),
    pollIntervalMs: parsePositiveInt(env.POLL_INTERVAL_MS, 15_000, 'POLL_INTERVAL_MS'),
    maxReviewIterations: parsePositiveInt(env.MAX_REVIEW_ITERATIONS, 5, 'MAX_REVIEW_ITERATIONS'),
    autoMergeMethod,
    manualMergeBehavior,
    manualMergeLabel: env.MANUAL_MERGE_LABEL?.trim() || 'manual merge',
    readyToMergeLabel: env.READY_TO_MERGE_LABEL?.trim() || 'ready to merge',
    commentDelivery,
  };
}
