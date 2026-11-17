import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TicketRecord } from '../types.ts';

interface TicketRow {
  issue_number: number;
  project_item_id: string;
  lane: string;
  session_id: string | null;
  branch_name: string | null;
  worktree_path: string | null;
  pr_number: number | null;
  last_comment_id: number;
  last_pushed_at: string | null;
  review_iterations: number;
  manual_merge_notified: number;
  updated_at: string;
}

function rowToRecord(row: TicketRow): TicketRecord {
  return {
    issueNumber: row.issue_number,
    projectItemId: row.project_item_id,
    lane: row.lane,
    sessionId: row.session_id,
    branchName: row.branch_name,
    worktreePath: row.worktree_path,
    prNumber: row.pr_number,
    lastCommentId: row.last_comment_id,
    lastPushedAt: row.last_pushed_at,
    reviewIterations: row.review_iterations,
    manualMergeNotified: row.manual_merge_notified,
    updatedAt: row.updated_at,
  };
}

export class TicketStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS tickets (
        issue_number INTEGER PRIMARY KEY,
        project_item_id TEXT NOT NULL,
        lane TEXT NOT NULL,
        session_id TEXT,
        branch_name TEXT,
        worktree_path TEXT,
        pr_number INTEGER,
        last_comment_id INTEGER NOT NULL DEFAULT 0,
        last_pushed_at TEXT,
        review_iterations INTEGER NOT NULL DEFAULT 0,
        manual_merge_notified INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
    `);
  }

  get(issueNumber: number): TicketRecord | null {
    const stmt = this.db.prepare('SELECT * FROM tickets WHERE issue_number = ?');
    const row = stmt.get(issueNumber) as TicketRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  upsert(record: Omit<TicketRecord, 'updatedAt'>): TicketRecord {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO tickets (
        issue_number, project_item_id, lane, session_id, branch_name,
        worktree_path, pr_number, last_comment_id, last_pushed_at,
        review_iterations, manual_merge_notified, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(issue_number) DO UPDATE SET
        project_item_id = excluded.project_item_id,
        lane = excluded.lane,
        session_id = excluded.session_id,
        branch_name = excluded.branch_name,
        worktree_path = excluded.worktree_path,
        pr_number = excluded.pr_number,
        last_comment_id = excluded.last_comment_id,
        last_pushed_at = excluded.last_pushed_at,
        review_iterations = excluded.review_iterations,
        manual_merge_notified = excluded.manual_merge_notified,
        updated_at = excluded.updated_at
    `);
    stmt.run(
      record.issueNumber,
      record.projectItemId,
      record.lane,
      record.sessionId,
      record.branchName,
      record.worktreePath,
      record.prNumber,
      record.lastCommentId,
      record.lastPushedAt,
      record.reviewIterations,
      record.manualMergeNotified,
      now,
    );
    return { ...record, updatedAt: now };
  }

  patch(issueNumber: number, fields: Partial<Omit<TicketRecord, 'issueNumber' | 'updatedAt'>>): TicketRecord {
    const existing = this.get(issueNumber);
    if (!existing) {
      throw new Error(`Ticket #${issueNumber} not found in store`);
    }
    return this.upsert({
      ...existing,
      ...fields,
      issueNumber,
    });
  }

  close(): void {
    this.db.close();
  }
}
