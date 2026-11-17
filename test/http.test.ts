import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { postJson, transportFor } from '../src/opencode/http.ts';

/**
 * `postJson` replaces `fetch` for the one OpenCode request that is allowed to
 * run for as long as the agent needs: `POST /session/{id}/message`, whose
 * response body does not arrive until the whole turn is done.
 *
 * Node's `fetch` (undici) enforces a 300-second body timeout and aborts with
 * `TypeError: fetch failed` (cause `UND_ERR_BODY_TIMEOUT`), so a turn longer
 * than five minutes was killed mid-flight. These tests pin the behaviour that
 * matters: the response is read to completion, and the timeout is the
 * caller's, not an invisible five-minute cap.
 */
describe('postJson', () => {
  it('reads a response body that arrives in parts', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.write('{"parts":[');
      setTimeout(() => res.end('{"type":"text"}]}'), 250);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const res = await postJson({ url: `http://127.0.0.1:${port}/message`, body: { a: 1 } });
      assert.equal(res.status, 200);
      assert.deepEqual(JSON.parse(res.text), { parts: [{ type: 'text' }] });
    } finally {
      server.close();
    }
  });

  it('sends the JSON body and the caller headers', async () => {
    let seenBody = '';
    let seenAuth: string | undefined;
    let seenContentType: string | undefined;

    const server = createServer((req, res) => {
      seenAuth = req.headers.authorization;
      seenContentType = req.headers['content-type'];
      req.on('data', (c: Buffer) => (seenBody += c.toString('utf8')));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"parts":[]}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      await postJson({
        url: `http://127.0.0.1:${port}/message?directory=%2Ftmp`,
        body: { model: { providerID: 'kilo', modelID: 'kilo-auto/balanced' } },
        headers: { Authorization: 'Basic abc' },
      });
      assert.equal(seenAuth, 'Basic abc');
      assert.equal(seenContentType, 'application/json');
      assert.deepEqual(JSON.parse(seenBody), {
        model: { providerID: 'kilo', modelID: 'kilo-auto/balanced' },
      });
    } finally {
      server.close();
    }
  });

  it('returns the status and body of an error response', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"name":"UnknownError"}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const res = await postJson({ url: `http://127.0.0.1:${port}/message`, body: {} });
      assert.equal(res.status, 500);
      assert.equal(res.text, '{"name":"UnknownError"}');
    } finally {
      server.close();
    }
  });

  it('aborts when the caller sets a timeout and the server never answers', async () => {
    const server = createServer(() => {
      /* never responds */
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
      await assert.rejects(
        postJson({
          url: `http://127.0.0.1:${port}/message`,
          body: {},
          timeoutMs: 300,
        }),
        /timed out/i,
      );
    } finally {
      server.close();
    }
  });

  it('picks the transport that matches the URL scheme', () => {
    assert.equal(transportFor('http:'), http);
    assert.equal(transportFor('https:'), https);
    assert.throws(() => transportFor('ftp:'), /Unsupported protocol/);
  });

  it('does not reject an https:// URL with ERR_INVALID_PROTOCOL', async () => {
    // Port 1 is closed, so this fails at connect time. What matters is that
    // it fails THERE and not with ERR_INVALID_PROTOCOL, which `http.request`
    // throws before it ever opens a socket.
    await assert.rejects(
      postJson({ url: 'https://127.0.0.1:1/message', body: {} }),
      (err: NodeJS.ErrnoException) => {
        assert.notEqual(err.code, 'ERR_INVALID_PROTOCOL');
        assert.ok(
          ['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENOTFOUND'].includes(err.code ?? ''),
          `expected a connection error, got ${err.code}: ${err.message}`,
        );
        return true;
      },
    );
  });

  it('rejects an unsupported scheme with a clear message', async () => {
    await assert.rejects(
      postJson({ url: 'ftp://example.com/message', body: {} }),
      /Unsupported protocol "ftp:"/,
    );
  });
});
