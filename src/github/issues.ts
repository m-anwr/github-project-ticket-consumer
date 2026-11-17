import { mkdirSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { DownloadedAsset, IssueComment } from '../types.ts';
import type { GitHubClient } from './client.ts';

interface RawIssueComment {
  id: number;
  user: { login: string } | null;
  body: string;
  created_at: string;
  updated_at: string;
}

const ATTACHMENT_URL_REGEX =
  /https:\/\/(?:github\.com\/user-attachments\/(?:assets|files)\/[^\s)"'<>]+|(?:private-)?user-images\.githubusercontent\.com\/[^\s)"'<>]+)/gi;

export function extractAssetUrls(markdown: string): string[] {
  const matches = markdown.match(ATTACHMENT_URL_REGEX) || [];
  return [...new Set(matches)];
}

function extensionFromMime(mime: string): string {
  const clean = mime.split(';')[0]?.trim().toLowerCase();
  const map: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
    'application/json': '.json',
  };
  return (clean && map[clean]) || '';
}

export class GitHubIssuesClient {
  private readonly client: GitHubClient;
  private readonly owner: string;
  private readonly repo: string;

  constructor(client: GitHubClient, owner: string, repo: string) {
    this.client = client;
    this.owner = owner;
    this.repo = repo;
  }

  async listComments(issueNumber: number): Promise<IssueComment[]> {
    const raw = await this.client.rest<RawIssueComment[]>(
      `/repos/${this.owner}/${this.repo}/issues/${issueNumber}/comments?per_page=100`,
    );
    return raw.map((c) => ({
      id: c.id,
      author: c.user?.login || '',
      body: c.body || '',
      createdAt: c.created_at,
      updatedAt: c.updated_at,
    }));
  }

  async getNewHumanComments(
    issueNumber: number,
    sinceCommentId: number,
    allowedAuthors: string[],
  ): Promise<IssueComment[]> {
    const allowedSet = new Set(allowedAuthors.map((a) => a.toLowerCase()));
    const comments = await this.listComments(issueNumber);
    return comments.filter(
      (c) =>
        c.id > sinceCommentId &&
        allowedSet.has(c.author.toLowerCase()) &&
        !c.body.includes('<!-- opencode-bot -->'),
    );
  }

  async postComment(issueNumber: number, body: string): Promise<number> {
    const tagged = `${body}\n\n<!-- opencode-bot -->`;
    const created = await this.client.rest<{ id: number }>(
      `/repos/${this.owner}/${this.repo}/issues/${issueNumber}/comments`,
      {
        method: 'POST',
        body: { body: tagged },
      },
    );
    return created.id;
  }

  async addLabels(issueNumber: number, labels: string[]): Promise<void> {
    if (labels.length === 0) return;
    await this.client.rest(`/repos/${this.owner}/${this.repo}/issues/${issueNumber}/labels`, {
      method: 'POST',
      body: { labels },
    });
  }

  async downloadAssets(markdown: string, destDir: string): Promise<DownloadedAsset[]> {
    const urls = extractAssetUrls(markdown);
    if (urls.length === 0) return [];

    mkdirSync(destDir, { recursive: true });
    const assets: DownloadedAsset[] = [];

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      try {
        const { buffer, contentType } = await this.client.downloadBinary(url);
        const urlPath = new URL(url).pathname;
        const baseExt = extname(urlPath);
        const ext = baseExt || extensionFromMime(contentType) || '.bin';
        const filename = `asset-${Date.now()}-${i + 1}${ext}`;
        const filePath = join(destDir, filename);
        writeFileSync(filePath, buffer);
        assets.push({
          filePath,
          mimeType: contentType.split(';')[0]?.trim() || 'application/octet-stream',
          filename,
          sourceUrl: url,
        });
      } catch (err) {
        console.warn(`[issues] Failed to download asset ${url}:`, err);
      }
    }

    return assets;
  }
}
