import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { OpenCodeClient } from '../src/opencode/client.ts';

/**
 * These tests encode the wire contract of a real OpenCode server, verified
 * against a running 1.19.x instance:
 *
 *   - v1 message body: `{ model: { providerID, modelID }, parts: [...] }`.
 *     The model MUST be nested; flat `providerID`/`modelID` are ignored and
 *     the server silently falls back to its own default model.
 *   - v1 permission reply: `POST /session/{id}/permissions/{permissionID}`
 *     with `{ response: 'once' }`. The `/permission/{id}/reply` path is not
 *     served at all.
 *   - v1 probe answer: `{"name":"UnknownError", ...}` for an unknown session.
 *   - v2 prompt body: `{ text }` at the top level. The preview API took
 *     `{ prompt: { text } }`, but 2.4.1 rejects that with
 *     `Missing key at ["text"]`.
 *   - v2 permission reply body: `{ decision: 'once' }` (`reply` and `allow`
 *     are both rejected).
 *   - v2 model ref: `{ model: { id, providerID } }`.
 *   - v2 directory selection: `location: { directory }` in the create body.
 *   - v2 probe answer: `{"_tag":"InvalidRequestError", ...}`.
 *
 * A route that does not exist falls through to the SPA and answers
 * `text/html`; that is how detection tells the two dialects apart.
 */

const V1_PROBE_ERROR = JSON.stringify({
  name: 'UnknownError',
  data: { message: 'Unexpected server error', ref: 'err_test' },
});

const V2_PROBE_ERROR = JSON.stringify({
  _tag: 'InvalidRequestError',
  message: 'Invalid session ID',
  field: 'sessionID',
});

describe('OpenCodeClient', () => {
  it('speaks the v1 dialect: /session, /message with file parts, /event', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opencode-v1-test-'));
    const assetPath = join(dir, 'mockup.png');
    writeFileSync(assetPath, Buffer.from('fake-png-bytes'));

    let permissionReplied = false;
    let receivedParts: Array<{ type: string; mime?: string; url?: string }> = [];
    let receivedModel: { providerID?: string; modelID?: string } | undefined;

    const server = createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');

      // Detection probe: an unknown session id must produce the v1 error
      // envelope, not the SPA fallback.
      if (req.method === 'POST' && url.pathname === '/session/probe-does-not-exist/message') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(V1_PROBE_ERROR);
        return;
      }

      // This server also exposes the v2 surface; detection must still choose
      // v1 because the classic route is present.
      if (req.method === 'POST' && url.pathname === '/api/session/probe-does-not-exist/prompt') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(V2_PROBE_ERROR);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/session') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'ses_v1', title: 'Test' }));
        return;
      }

      if (req.method === 'GET' && url.pathname === '/event') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(
          `data: ${JSON.stringify({
            type: 'permission.asked',
            properties: { id: 'per_1', sessionID: 'ses_v1', permission: 'bash' },
          })}\n\n`,
        );
        req.on('close', () => res.end());
        return;
      }

      // The live route is /permissions (plural), with no /reply suffix.
      if (req.method === 'POST' && url.pathname === '/session/ses_v1/permissions/per_1') {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            response?: string;
          };
          assert.equal(parsed.response, 'once');
          permissionReplied = true;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('true');
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/session/ses_v1/message') {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            model?: { providerID?: string; modelID?: string };
            parts: Array<{ type: string; mime?: string; url?: string }>;
          };
          receivedParts = body.parts;
          receivedModel = body.model;
          setTimeout(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                info: { role: 'assistant' },
                parts: [
                  {
                    type: 'text',
                    text: 'Done!\n<ticket-status>{"status":"ready_for_review","pr_title":"feat: v1","pr_summary":"Implemented"}</ticket-status>',
                  },
                ],
              }),
            );
          }, 30);
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Expected TCP address');

    try {
      const client = new OpenCodeClient({
        serverUrl: `http://127.0.0.1:${addr.port}`,
        providerId: 'anthropic',
        modelId: 'claude-sonnet',
      });

      assert.equal(await client.detectMode(), 'v1');

      const sessionId = await client.createSession(dir, 'Issue #1');
      assert.equal(sessionId, 'ses_v1');

      const result = await client.sendPromptAndWait(sessionId, dir, 'Build it', [
        {
          filePath: assetPath,
          mimeType: 'image/png',
          filename: 'mockup.png',
          sourceUrl: 'https://github.com/user-attachments/assets/1',
        },
      ]);

      assert.equal(permissionReplied, true);
      assert.equal(receivedParts.length, 2);
      assert.equal(receivedParts[1].type, 'file');
      // The model must be nested, or the server ignores it.
      assert.deepEqual(receivedModel, { providerID: 'anthropic', modelID: 'claude-sonnet' });
      assert.deepEqual(result, {
        status: 'ready_for_review',
        prTitle: 'feat: v1',
        prSummary: 'Implemented',
        prNumber: undefined,
        rawText: 'Done!',
      });
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('speaks the v2 dialect: /api/session, /api/session/:id/prompt with {text}', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opencode-v2-test-'));
    let receivedText = '';
    let receivedPromptBody: { text?: string } = {};
    let modelSwitched = false;
    let createBody: { location?: { directory?: string } } = {};

    const server = createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');

      // No v1 message route here: it must fall through to the SPA so
      // detection skips the classic dialect.
      if (req.method === 'POST' && url.pathname === '/session/probe-does-not-exist/message') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html></html>');
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/session/probe-does-not-exist/prompt') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(V2_PROBE_ERROR);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/session') {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          createBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ data: { id: 'ses_v2', title: 'Test' } }));
        });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/session/ses_v2/model') {
        modelSwitched = true;
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/event') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        req.on('close', () => res.end());
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/session/ses_v2/prompt') {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            prompt?: { text?: string };
          };
          receivedPromptBody = body;
          receivedText = body.text || '';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              data: {
                parts: [
                  {
                    type: 'text',
                    text: '<ticket-status>{"status":"needs_input","question":"Which DB?"}</ticket-status>',
                  },
                ],
              },
            }),
          );
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Expected TCP address');

    try {
      const client = new OpenCodeClient({
        serverUrl: `http://127.0.0.1:${addr.port}`,
        providerId: 'kilo',
        modelId: 'kilo-auto/efficient',
      });

      assert.equal(await client.detectMode(), 'v2');

      const sessionId = await client.createSession(dir, 'Issue #2');
      assert.equal(sessionId, 'ses_v2');
      assert.equal(modelSwitched, true);
      // v2 selects the directory with a location object, not a query param.
      assert.deepEqual(createBody, { location: { directory: dir } });

      const result = await client.sendPromptAndWait(sessionId, dir, 'Build v2');
      // The prompt text must be at the top level of the body.
      assert.deepEqual(receivedPromptBody, { text: 'Build v2' });
      assert.equal(receivedText, 'Build v2');
      assert.deepEqual(result, {
        status: 'needs_input',
        question: 'Which DB?',
        rawText: '',
      });
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
