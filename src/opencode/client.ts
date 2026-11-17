import { readFileSync } from 'node:fs';
import { log } from '../logger.ts';
import type { DownloadedAsset, OpenCodeTicketStatus } from '../types.ts';

export interface OpenCodeConfig {
  serverUrl: string;
  providerId: string;
  modelId: string;
  username?: string;
  password?: string;
}

type ApiMode = 'v1' | 'v2';

interface SessionResponse {
  id?: string;
  title?: string;
  data?: { id?: string; title?: string };
}

interface MessagePart {
  type: string;
  text?: string;
  id?: string;
  messageID?: string;
  sessionID?: string;
}

interface SessionMessageEnvelope {
  id?: string;
  type?: string;
  outcome?: string;
  time?: { created?: number };
  content?: MessagePart[];
  info?: { id: string; role: string; error?: unknown };
  parts?: MessagePart[];
}

export function parseTicketStatus(text: string): OpenCodeTicketStatus {
  const matches = [...text.matchAll(/<ticket-status>\s*([\s\S]*?)\s*<\/ticket-status>/gi)];
  const lastMatch = matches.at(-1);
  if (!lastMatch) {
    return { status: 'unknown', rawText: text };
  }

  try {
    const parsed = JSON.parse(lastMatch[1]) as {
      status?: string;
      question?: string;
      pr_title?: string;
      pr_summary?: string;
    };

    if (parsed.status === 'needs_input' && parsed.question?.trim()) {
      return { status: 'needs_input', question: parsed.question.trim() };
    }

    if (parsed.status === 'ready_for_review') {
      return {
        status: 'ready_for_review',
        prTitle: parsed.pr_title?.trim() || undefined,
        prSummary: parsed.pr_summary?.trim() || undefined,
      };
    }
  } catch {
    // Fall through to unknown
  }

  return { status: 'unknown', rawText: text };
}

export class OpenCodeClient {
  private readonly cfg: OpenCodeConfig;
  private detectedMode: ApiMode | null = null;

  constructor(cfg: OpenCodeConfig) {
    this.cfg = cfg;
  }

  private authHeaders(): Record<string, string> {
    if (!this.cfg.password) return {};
    const token = Buffer.from(`${this.cfg.username || 'opencode'}:${this.cfg.password}`).toString(
      'base64',
    );
    return { Authorization: `Basic ${token}` };
  }

  private buildUrl(path: string, directory?: string): string {
    const url = new URL(`${this.cfg.serverUrl}${path}`);
    if (directory) {
      url.searchParams.set('directory', directory);
    }
    return url.toString();
  }

  async detectMode(): Promise<ApiMode> {
    if (this.detectedMode) return this.detectedMode;

    const v2Res = await fetch(this.buildUrl('/api/session'), {
      headers: this.authHeaders(),
    }).catch(() => null);
    if (v2Res?.ok && v2Res.headers.get('content-type')?.includes('application/json')) {
      this.detectedMode = 'v2';
      log.info('opencode', `Detected OpenCode v2 API at ${this.cfg.serverUrl}`);
      return 'v2';
    }

    const v1Res = await fetch(this.buildUrl('/session'), {
      headers: this.authHeaders(),
    }).catch(() => null);
    if (v1Res?.ok && v1Res.headers.get('content-type')?.includes('application/json')) {
      this.detectedMode = 'v1';
      log.info('opencode', `Detected OpenCode v1 API at ${this.cfg.serverUrl}`);
      return 'v1';
    }

    throw new Error(
      `Could not detect OpenCode API version at ${this.cfg.serverUrl} (tried /api/session and /session)`,
    );
  }

  async createSession(directory: string, title: string): Promise<string> {
    const mode = await this.detectMode();
    const prefix = mode === 'v2' ? '/api' : '';

    const res = await fetch(this.buildUrl(`${prefix}/session`, directory), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders(),
      },
      body: JSON.stringify({ title }),
    });
    if (!res.ok) {
      throw new Error(`OpenCode createSession failed (${res.status}): ${await res.text()}`);
    }
    const body = (await res.json()) as SessionResponse;
    const id = body.data?.id ?? body.id;
    if (!id) {
      throw new Error(`OpenCode createSession missing session id in response: ${JSON.stringify(body)}`);
    }
    log.info('opencode', `Created session ${id} (${mode}) in ${directory}`);

    if (mode === 'v2' && this.cfg.providerId && this.cfg.modelId) {
      await fetch(this.buildUrl(`/api/session/${id}/model`, directory), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.authHeaders(),
        },
        body: JSON.stringify({
          providerID: this.cfg.providerId,
          modelID: this.cfg.modelId,
        }),
      }).catch(() => undefined);
    }

    return id;
  }

  async sendPromptAndWait(
    sessionId: string,
    directory: string,
    promptText: string,
    assets: DownloadedAsset[] = [],
  ): Promise<OpenCodeTicketStatus> {
    const mode = await this.detectMode();
    const prefix = mode === 'v2' ? '/api' : '';
    const abortController = new AbortController();
    const collectedTextParts = new Map<string, string>();
    const loggedToolCalls = new Set<string>();
    let latestAssistantMessageId: string | null = null;
    let sessionError: string | null = null;
    let resolveIdle!: () => void;
    const idlePromise = new Promise<void>((resolve) => {
      resolveIdle = resolve;
    });

    log.info(
      'opencode',
      `Sending prompt to session ${sessionId} (${mode}, model=${this.cfg.providerId}/${this.cfg.modelId}, assets=${assets.length})`,
    );

    const sseTask = this.watchEvents(
      `${prefix}/event`,
      directory,
      abortController.signal,
      (event) => {
        if (event.type === 'message.updated') {
          const info = event.properties?.info as
            | { id?: string; role?: string; sessionID?: string }
            | undefined;
          if (info?.sessionID === sessionId && info.role === 'assistant' && info.id) {
            latestAssistantMessageId = info.id;
          }
        } else if (event.type === 'message.part.updated') {
          const part = event.properties?.part as
            | (MessagePart & { name?: string; state?: { status?: string } })
            | undefined;
          if (
            part?.sessionID === sessionId &&
            part.type === 'tool' &&
            part.id &&
            part.state?.status === 'running' &&
            !loggedToolCalls.has(part.id)
          ) {
            loggedToolCalls.add(part.id);
            log.info('opencode', `[${sessionId}] Running tool: ${part.name || 'unknown'}`);
          } else if (
            part?.sessionID === sessionId &&
            part.type === 'text' &&
            typeof part.text === 'string' &&
            part.id
          ) {
            if (!latestAssistantMessageId || part.messageID === latestAssistantMessageId) {
              collectedTextParts.set(part.id, part.text);
            }
          }
        } else if (event.type === 'permission.updated' || event.type === 'permission.asked') {
          const perm = event.properties as
            | { id?: string; sessionID?: string; title?: string; permission?: string }
            | undefined;
          if (perm?.sessionID === sessionId && perm.id) {
            void this.replyPermission(prefix, sessionId, perm.id, directory, perm.title || perm.permission);
          }
        } else if (event.type === 'session.idle') {
          const props = event.properties as { sessionID?: string } | undefined;
          if (!props?.sessionID || props.sessionID === sessionId) {
            resolveIdle();
          }
        } else if (event.type === 'session.status') {
          const props = event.properties as
            | { sessionID?: string; status?: { type?: string } }
            | undefined;
          if (props?.sessionID === sessionId && props.status?.type === 'idle') {
            resolveIdle();
          }
        } else if (event.type === 'session.error') {
          const props = event.properties as
            | { sessionID?: string; error?: { name?: string; message?: string } }
            | undefined;
          if (!props?.sessionID || props.sessionID === sessionId) {
            sessionError = props?.error?.message || props?.error?.name || 'OpenCode session error';
            resolveIdle();
          }
        }
      },
    ).catch(() => undefined);

    try {
      let finalText = '';

      if (mode === 'v2') {
        const promptStartedAt = Date.now() - 1000;
        const res = await fetch(this.buildUrl(`/api/session/${sessionId}/prompt`, directory), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...this.authHeaders(),
          },
          body: JSON.stringify({
            text: promptText,
          }),
        });

        if (!res.ok) {
          throw new Error(`OpenCode prompt failed (${res.status}): ${await res.text()}`);
        }

        const rawResult = (await res.json()) as {
          parts?: MessagePart[];
          error?: string | { message?: string };
          data?: { parts?: MessagePart[]; error?: string | { message?: string } };
        };
        const msgResult = rawResult.data ?? rawResult;
        if (msgResult.error) {
          const errMsg =
            typeof msgResult.error === 'string'
              ? msgResult.error
              : msgResult.error.message || JSON.stringify(msgResult.error);
          throw new Error(`OpenCode returned error: ${errMsg}`);
        }

        const directParts = msgResult.parts || [];
        if (directParts.length > 0) {
          finalText = directParts
            .filter((p) => p.type === 'text' && p.text)
            .map((p) => p.text!)
            .join('\n');
        } else {
          await Promise.race([
            idlePromise,
            this.pollV2UntilIdle(sessionId, directory, promptStartedAt, abortController.signal),
          ]);
        }
      } else {
        const parts: Array<Record<string, unknown>> = [{ type: 'text', text: promptText }];
        for (const asset of assets) {
          const base64 = readFileSync(asset.filePath).toString('base64');
          parts.push({
            type: 'file',
            mime: asset.mimeType,
            filename: asset.filename,
            url: `data:${asset.mimeType};base64,${base64}`,
          });
        }

        const res = await fetch(this.buildUrl(`/session/${sessionId}/message`, directory), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...this.authHeaders(),
          },
          body: JSON.stringify({
            providerID: this.cfg.providerId,
            modelID: this.cfg.modelId,
            parts,
          }),
        });

        if (!res.ok) {
          throw new Error(`OpenCode message failed (${res.status}): ${await res.text()}`);
        }

        const msgResult = (await res.json()) as {
          error?: string | { message?: string };
          parts?: MessagePart[];
        };
        if (msgResult.error) {
          const errMsg =
            typeof msgResult.error === 'string'
              ? msgResult.error
              : msgResult.error.message || JSON.stringify(msgResult.error);
          throw new Error(`OpenCode returned error: ${errMsg}`);
        }

        finalText = (msgResult.parts || [])
          .filter((p) => p.type === 'text' && p.text)
          .map((p) => p.text!)
          .join('\n');
      }

      if (sessionError) {
        throw new Error(sessionError);
      }

      if (!finalText && collectedTextParts.size > 0) {
        finalText = [...collectedTextParts.values()].join('\n');
      }

      if (!finalText) {
        finalText = await this.fetchLastAssistantText(prefix, sessionId, directory);
      }

      const parsed = parseTicketStatus(finalText);
      log.info('opencode', `Session ${sessionId} finished with status=${parsed.status}`);
      return parsed;
    } finally {
      abortController.abort();
      await sseTask;
    }
  }

  private async pollV2UntilIdle(
    sessionId: string,
    directory: string,
    promptStartedAt: number,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      await new Promise((r) => setTimeout(r, 3000));
      if (signal.aborted) return;
      try {
        const res = await fetch(this.buildUrl(`/api/session/${sessionId}/message`, directory), {
          headers: this.authHeaders(),
          signal,
        });
        if (!res.ok) continue;
        const raw = (await res.json()) as { data?: SessionMessageEnvelope[] };
        const messages = raw.data || [];
        const idleMsg = messages.find(
          (m) => m.type === 'idle' && (m.time?.created ?? 0) >= promptStartedAt,
        );
        if (idleMsg) return;
      } catch {
        // Ignore transient poll errors
      }
    }
  }

  private async fetchLastAssistantText(
    prefix: string,
    sessionId: string,
    directory: string,
  ): Promise<string> {
    const res = await fetch(this.buildUrl(`${prefix}/session/${sessionId}/message`, directory), {
      headers: this.authHeaders(),
    });
    if (!res.ok) return '';
    const raw = (await res.json()) as SessionMessageEnvelope[] | { data?: SessionMessageEnvelope[] };
    const messages = Array.isArray(raw) ? raw : raw.data || [];

    // OpenCode v2 returns newest-first with type: 'assistant' and content: [...]
    const v2Assistant = messages.find(
      (m) =>
        m.type === 'assistant' &&
        Array.isArray(m.content) &&
        m.content.some((p) => p.type === 'text' && p.text),
    );
    if (v2Assistant?.content) {
      return v2Assistant.content
        .filter((p) => p.type === 'text' && p.text)
        .map((p) => p.text!)
        .join('\n');
    }

    // OpenCode v1 returns oldest-first with info.role === 'assistant' and parts: [...]
    const v1Assistant = [...messages].reverse().find((m) => m.info?.role === 'assistant');
    if (!v1Assistant?.parts) return '';
    return v1Assistant.parts
      .filter((p) => p.type === 'text' && p.text)
      .map((p) => p.text!)
      .join('\n');
  }

  private async replyPermission(
    prefix: string,
    sessionId: string,
    requestId: string,
    directory: string,
    title?: string,
  ): Promise<void> {
    console.log(`[opencode] Auto-approving permission "${title || requestId}" for session ${sessionId}`);
    await fetch(
      this.buildUrl(`${prefix}/session/${sessionId}/permission/${requestId}/reply`, directory),
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.authHeaders(),
        },
        body: JSON.stringify({ decision: 'once', reply: 'once' }),
      },
    ).catch((err) => {
      console.warn(`[opencode] Failed to reply to permission ${requestId}:`, err);
    });
  }

  private async watchEvents(
    eventPath: string,
    directory: string,
    signal: AbortSignal,
    onEvent: (event: { type: string; properties?: Record<string, unknown> }) => void,
  ): Promise<void> {
    const res = await fetch(this.buildUrl(eventPath, directory), {
      headers: {
        Accept: 'text/event-stream',
        ...this.authHeaders(),
      },
      signal,
    });
    if (!res.ok || !res.body) return;

    const decoder = new TextDecoder();
    let buffer = '';
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() || '';
      for (const frame of frames) {
        const dataLines = frame
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim());
        if (dataLines.length === 0) continue;
        try {
          const parsed = JSON.parse(dataLines.join('\n')) as {
            type: string;
            properties?: Record<string, unknown>;
          };
          onEvent(parsed);
        } catch {
          // Ignore keepalive or malformed SSE frame
        }
      }
    }
  }
}
