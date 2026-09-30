#!/usr/bin/env node
// Phase 0 probe: append every hook POST body, untouched, to a JSONL file.
// Usage: node scripts/probe/recorder.mjs <port> <out.jsonl>
import http from 'node:http';
import fs from 'node:fs';

const port = Number(process.argv[2] ?? 7788);
const out = process.argv[3] ?? 'probe-payloads.jsonl';

http
  .createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      // Empty 204 first: Claude Code treats it as "no decision".
      res.writeHead(204).end();
      const raw = Buffer.concat(chunks).toString('utf8');
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        body = { __unparsed: raw.slice(0, 2000) };
      }
      const line = { receivedAt: Date.now(), method: req.method, url: req.url, headers: req.headers, body };
      fs.appendFileSync(out, JSON.stringify(line) + '\n');
    });
  })
  .listen(port, '127.0.0.1', () => console.log(`recorder listening on ${port} -> ${out}`));
