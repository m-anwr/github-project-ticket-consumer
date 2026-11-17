export class GitHubApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, url: string, body: string) {
    super(`GitHub API ${status} for ${url}: ${body.slice(0, 400)}`);
    this.status = status;
    this.body = body;
  }
}

export class GitHubClient {
  private readonly token: string;
  private readonly baseUrl: string;

  constructor(token: string, baseUrl = 'https://api.github.com') {
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async rest<T>(
    path: string,
    options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<T> {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'github-project-ticket-consumer',
        ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new GitHubApiError(res.status, url, text);
    }

    if (res.status === 204) {
      return undefined as T;
    }

    return (await res.json()) as T;
  }

  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const res = await this.rest<{ data?: T; errors?: Array<{ message: string }> }>('/graphql', {
      method: 'POST',
      body: { query, variables },
    });

    if (res.errors?.length) {
      throw new Error(`GitHub GraphQL error: ${res.errors.map((e) => e.message).join('; ')}`);
    }
    if (!res.data) {
      throw new Error('GitHub GraphQL response missing data');
    }
    return res.data;
  }

  async downloadBinary(url: string): Promise<{ buffer: Buffer; contentType: string }> {
    const headers: Record<string, string> = {
      'User-Agent': 'github-project-ticket-consumer',
    };
    const parsed = new URL(url);
    if (
      parsed.hostname === 'github.com' ||
      parsed.hostname.endsWith('.githubusercontent.com') ||
      parsed.hostname === 'api.github.com'
    ) {
      headers.Authorization = `Bearer ${this.token}`;
    }

    const res = await fetch(url, { headers, redirect: 'follow' });
    if (!res.ok) {
      throw new GitHubApiError(res.status, url, await res.text().catch(() => ''));
    }
    const arrayBuffer = await res.arrayBuffer();
    const contentType = res.headers.get('content-type') || 'application/octet-stream';
    return { buffer: Buffer.from(arrayBuffer), contentType };
  }
}
