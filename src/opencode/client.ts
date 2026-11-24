import { readFileSync } from 'node:fs';
import { log } from '../logger.ts';
import type { DownloadedAsset, OpenCodeTicketStatus } from '../types.ts';
import { postJson } from './http.ts';

export interface OpenCodeConfig {
  serverUrl: string;
  providerId: string;
  modelId: string;
  username?: string;
  password?: string;
  /**
   * Inactivity timeout for the long-running message POST, in milliseconds.
   * 0 (the default) means no timeout: an agent turn can legitimately take
   * far longer than any fixed budget. See src/opencode/http.ts for why
   * `fetch` cannot be used for that request.
   */
  messageTimeoutMs?: number;
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

  // The agent's own words, with the machine-readable block taken out. This is
  // what the PR description is built from: it is the complete report, where
  // `pr_summary` is only the one paragraph the agent chose to compress.
  const rawText = text.slice(0, lastMatch.index).trim();

  try {
    const parsed = JSON.parse(lastMatch[1]) as {
      status?: string;
      question?: string;
      pr_title?: string;
      pr_summary?: string;
      pr_number?: number | string;
    };

    if (parsed.status === 'needs_input' && parsed.question?.trim()) {
      return { status: 'needs_input', question: parsed.question.trim(), rawText };
    }

    if (parsed.status === 'ready_for_review') {
      const prNumber =
        typeof parsed.pr_number === 'number'
          ? parsed.pr_number
          : typeof parsed.pr_number === 'string' && /^\d+$/.test(parsed.pr_number.trim())
            ? Number(parsed.pr_number.trim())
            : undefined;
      return {
        status: 'ready_for_review',
        prTitle: parsed.pr_title?.trim() || undefined,
        prSummary: parsed.pr_summary?.trim() || undefined,
        prNumber: prNumber && prNumber > 0 ? prNumber : undefined,
        rawText,
      };
    }
  } catch {
    // Fall through to unknown
  }

  // The report is the text before the block, whatever the block contained:
  // the `<ticket-status>` JSON is machine-readable and must never end up in
  // a pull request description.
  return { status: 'unknown', rawText };
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

  /**
   * Probe the server and decide which API dialect to speak.
   *
   * OpenCode 1.19.x serves BOTH the classic `/session` API and the newer
   * `/api/session` API from the same process, so the mere presence of
   * `/api/session` does not mean the server speaks v2. Probing only for
   * existence misdetects a v1 server as v2, after which every call uses the
   * wrong payload shape (and the v2 preview on 1.19.x never returns an
   * assistant message, so the run would hang until it times out).
   *
   * The classic `/session` dialect is the one that is fully implemented on
   * OpenCode 1.x, so we prefer it whenever its route exists. A genuine
   * OpenCode 2.x server does not expose `/session/{id}/message` at all: the
   * route falls through to the SPA and answers `text/html`, which is how we
   * detect its absence and fall through to the v2 dialect.
   *
   * Each probe posts a body that is valid *for that dialect*, so the server
   * validates the payload before it looks anything up:
   *   - v1 (`POST /session/{id}/message`) answers with a `name`/`data`
   *     envelope ("UnknownError" for an unknown session).
   *   - v2 (`POST /api/session/{id}/prompt`) answers with a `_tag`/`kind`
   *     envelope ("InvalidRequestError" for an unknown session).
   */
  async detectMode(): Promise<ApiMode> {
    if (this.detectedMode) return this.detectedMode;

    const v1Probe = await this.probeMessageEndpoint('/session/probe-does-not-exist/message', {
      model: { providerID: this.cfg.providerId, modelID: this.cfg.modelId },
      parts: [{ type: 'text', text: 'probe' }],
    });
    if (v1Probe === 'v1') {
      this.detectedMode = 'v1';
      log.info('opencode', `Detected OpenCode v1 API at ${this.cfg.serverUrl}`);
      return 'v1';
    }

    const v2Probe = await this.probeMessageEndpoint('/api/session/probe-does-not-exist/prompt', {
      prompt: { text: 'probe' },
    });
    if (v2Probe === 'v2') {
      this.detectedMode = 'v2';
      log.info('opencode', `Detected OpenCode v2 API at ${this.cfg.serverUrl}`);
      return 'v2';
    }

    throw new Error(
      `Could not detect OpenCode API version at ${this.cfg.serverUrl} ` +
        `(probed /session/.../message and /api/session/.../prompt)`,
    );
  }

  /**
   * POST a dialect-valid body to a message endpoint and classify the reply.
   *
   * Returns 'v1' / 'v2' when the route exists and validated the body, and
   * null when the route is absent (it falls through to the SPA and answers
   * text/html) or the server could not be reached.
   */
  private async probeMessageEndpoint(path: string, body: unknown): Promise<ApiMode | null> {
    const res = await fetch(this.buildUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify(body),
    }).catch(() => null);
    if (!res) return null;

    const ctype = res.headers.get('content-type') || '';
    if (!ctype.includes('application/json')) return null;

    const text = await res.text().catch(() => '');

    // The v1 dialect uses the `name`/`data` envelope; the v2 dialect uses
    // `_tag`/`kind`. Distinguish on that, not on the message text.
    if (text.includes('"name":"BadRequest"') || text.includes('"name":"UnknownError"')) {
      return 'v1';
    }
    if (text.includes('"_tag"') || text.includes('"kind":"Payload"')) return 'v2';
    return null;
  }

  async createSession(directory: string, title: string): Promise<string> {
    const mode = await this.detectMode();
    const prefix = mode === 'v2' ? '/api' : '';

    // The v2 API selects the working directory with a `location` object in
    // the body; the v1 API uses a `?directory=` query parameter. Passing the
    // query parameter to v2 is silently ignored, so the session would be
    // created in the server's own working directory instead of the ticket's
    // worktree.
    const body: Record<string, unknown> = mode === 'v2' ? { location: { directory } } : { title };
    if (mode === 'v1') body.title = title;

    const res = await fetch(this.buildUrl(`${prefix}/session`, directory), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders(),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`OpenCode createSession failed (${res.status}): ${await res.text()}`);
    }
    const bodyResp = (await res.json()) as SessionResponse;
    const id = bodyResp.data?.id ?? bodyResp.id;
    if (!id) {
      throw new Error(
        `OpenCode createSession missing session id in response: ${JSON.stringify(bodyResp)}`,
      );
    }
    log.info('opencode', `Created session ${id} (${mode}) in ${directory}`);

    if (mode === 'v2' && this.cfg.providerId && this.cfg.modelId) {
      // The v2 model endpoint takes a ModelRef: `{ model: { id, providerID } }`.
      // `id` is the bare model id, without the provider prefix.
      await fetch(this.buildUrl(`/api/session/${id}/model`, directory), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...this.authHeaders(),
        },
        body: JSON.stringify({
          model: {
            id: this.cfg.modelId,
            providerID: this.cfg.providerId,
          },
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
            | (MessagePart & {
                name?: string;
                tool?: string;
                state?: { status?: string };
              })
            | undefined;
          if (
            part?.sessionID === sessionId &&
            part.type === 'tool' &&
            part.id &&
            part.state?.status === 'running' &&
            !loggedToolCalls.has(part.id)
          ) {
            loggedToolCalls.add(part.id);
            // The live server names the tool in `tool`, not `name`.
            log.info(
              'opencode',
              `[${sessionId}] Running tool: ${part.name || part.tool || 'unknown'}`,
            );
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
          // The live server emits `permission.asked` with `properties.id`
          // holding the permission id (e.g. "per_..."), `properties.sessionID`
          // and `properties.permission` naming the permission type.
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
    ).catch((err) => {
      // The server sends a keepalive roughly every ten seconds, so this stream
      // should not die on its own. If it does, say so rather than failing
      // silently: a dead stream means the idle event never arrives and the
      // turn would never be seen as finished. Our own teardown abort is not
      // a failure, so it stays quiet.
      if (abortController.signal.aborted) return;
      log.warn('opencode', `Event stream for session ${sessionId} ended unexpectedly`, err);
    });

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
          // The v2 prompt endpoint takes the text at the TOP level: `{ text }`.
          //
          // The preview API took `{ prompt: { text } }`, and OpenCode 2.4.1
          // rejects that with `Missing key at ["text"]` -- the schema wants
          // `text` on the root object, so the nesting has to go the other
          // way round.
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
          // The v2 prompt endpoint acknowledges the prompt rather than
          // returning the reply, so wait for the turn to finish and then
          // read the assistant message back.
          await Promise.race([
            idlePromise,
            this.pollV2UntilIdle(sessionId, directory, promptStartedAt, abortController.signal),
          ]);
          finalText = await this.fetchLastAssistantText(prefix, sessionId, directory);
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

        // This POST holds its response open for the WHOLE agent turn: the v1
        // dialect returns the assistant message synchronously, so the body
        // does not arrive until the agent has finished its tool calls. That
        // makes it unfit for `fetch`, whose 300 s body timeout would abort
        // any turn longer than five minutes with an opaque "fetch failed".
        // `postJson` (node:http) has no such default.
        const res = await postJson({
          url: this.buildUrl(`/session/${sessionId}/message`, directory),
          body: {
            // The model MUST be nested under `model`. OpenCode ignores flat
            // `providerID`/`modelID` fields and silently falls back to the
            // server's default model instead of the one configured here.
            model: {
              providerID: this.cfg.providerId,
              modelID: this.cfg.modelId,
            },
            parts,
          },
          headers: this.authHeaders(),
          timeoutMs: this.cfg.messageTimeoutMs,
        });

        if (res.status < 200 || res.status >= 300) {
          throw new Error(`OpenCode message failed (${res.status}): ${res.text}`);
        }

        let msgResult: {
          error?: string | { message?: string };
          parts?: MessagePart[];
        };
        try {
          msgResult = JSON.parse(res.text);
        } catch {
          throw new Error(`OpenCode message returned invalid JSON: ${res.text.slice(0, 500)}`);
        }
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

    // The two dialects expose different routes and different body keys:
    //   - v1: POST /session/{sessionID}/permissions/{permissionID} {response}
    //   - v2: POST /api/session/{sessionID}/permission/{requestID}/reply {decision}
    // The v1 route is `/permissions` (plural) with no `/reply` suffix; the
    // old `/permission/{id}/reply` path is not served and silently falls
    // through to the SPA, so the approval would never be registered.
    // The v2 body key is `decision` (values `once` / `always` / `reject`);
    // `reply` and `allow` are both rejected.
    const isV2 = prefix === '/api';
    const url = isV2
      ? this.buildUrl(`/api/session/${sessionId}/permission/${requestId}/reply`, directory)
      : this.buildUrl(`/session/${sessionId}/permissions/${requestId}`, directory);
    const body = isV2 ? { decision: 'once' } : { response: 'once' };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...this.authHeaders(),
      },
      body: JSON.stringify(body),
    }).catch((err) => {
      console.warn(`[opencode] Failed to reply to permission ${requestId}:`, err);
      return null;
    });

    if (res && !res.ok) {
      console.warn(
        `[opencode] Permission reply for ${requestId} failed (${res.status}): ${await res.text()}`,
      );
    }
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
