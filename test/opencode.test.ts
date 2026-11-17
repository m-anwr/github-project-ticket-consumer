import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { OpenCodeClient } from '../src/opencode/client.ts';

describe('OpenCodeClient', () => {
  it('supports OpenCode v1 (/session, /message with file parts, /event)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opencode-v1-test-'));
    const assetPath = join(dir, 'mockup.png');
    writeFileSync(assetPath, Buffer.from('fake-png-bytes'));

    let permissionReplied = false;
    let receivedParts: Array<{ type: string; mime?: string; url?: string }> = [];

    const server = createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');

      if (req.method === 'GET' && url.pathname === '/api/session') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html></html>');
        return;
      }

      if (req.method === 'GET' && url.pathname === '/session') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([]));
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
            type: 'permission.updated',
            properties: { id: 'perm_1', sessionID: 'ses_v1', title: 'Run tests' },
          })}\n\n`,
        );
        req.on('close', () => res.end());
        return;
      }

      if (req.method === 'POST' && url.pathname === '/session/ses_v1/permission/perm_1/reply') {
        permissionReplied = true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/session/ses_v1/message') {
        const chunks: Buffer[] = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            parts: Array<{ type: string; mime?: string; url?: string }>;
          };
          receivedParts = body.parts;
          setTimeout(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                id: 'msg_1',
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
      assert.deepEqual(result, {
        status: 'ready_for_review',
        prTitle: 'feat: v1',
        prSummary: 'Implemented',
      });
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('supports OpenCode v2 (/api/session, /api/session/:id/prompt with text, /api/event)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opencode-v2-test-'));
    let receivedText = '';
    let modelSwitched = false;

    const server = createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');

      if (req.method === 'GET' && url.pathname === '/api/session') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [] }));
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/session') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: { id: 'ses_v2', title: 'Test' } }));
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
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { text?: string };
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

      const sessionId = await client.createSession(dir, 'Issue #2');
      assert.equal(sessionId, 'ses_v2');
      assert.equal(modelSwitched, true);

      const result = await client.sendPromptAndWait(sessionId, dir, 'Build v2');
      assert.equal(receivedText, 'Build v2');
      assert.deepEqual(result, {
        status: 'needs_input',
        question: 'Which DB?',
      });
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
