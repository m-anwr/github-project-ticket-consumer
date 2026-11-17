import http from 'node:http';

export interface HttpJsonResponse {
  status: number;
  text: string;
}

export interface PostJsonOptions {
  url: string;
  body: unknown;
  headers?: Record<string, string>;
  /**
   * Abort the request after this many milliseconds of inactivity.
   * 0 (the default) means "no timeout".
   */
  timeoutMs?: number;
}

/**
 * POST a JSON body and wait for the COMPLETE response.
 *
 * Why this exists instead of `fetch`:
 *
 * Node's global `fetch` is undici, and undici enforces a 300-second BODY
 * timeout -- a request whose response body does not finish within five
 * minutes is aborted with `TypeError: fetch failed` (cause:
 * `UND_ERR_BODY_TIMEOUT`). OpenCode's `POST /session/{id}/message` holds the
 * response open for the whole agent turn, because the v1 dialect returns the
 * assistant message synchronously. So every agent turn longer than five
 * minutes died mid-flight, and the orchestrator reported the opaque
 * "fetch failed" instead of the real cause.
 *
 * `node:http` has no such default: the timeout belongs to the caller. The
 * project stays dependency-free by using the stdlib instead of `undici`.
 *
 * The SSE `/event` stream does NOT need this: the server sends a keepalive
 * roughly every ten seconds, so the body timer is reset continuously.
 */
export function postJson(options: PostJsonOptions): Promise<HttpJsonResponse> {
  const { url, body, headers = {}, timeoutMs = 0 } = options;
  const target = new URL(url);
  const payload = Buffer.from(JSON.stringify(body));

  return new Promise<HttpJsonResponse>((resolve, reject) => {
    const req = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            text: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', reject);
      },
    );

    if (timeoutMs > 0) {
      // Socket inactivity timeout: a long-running turn that is producing no
      // data is exactly the case we want to allow, so this is opt-in.
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
      });
    }

    req.on('error', reject);
    req.end(payload);
  });
}
