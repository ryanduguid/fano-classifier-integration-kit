import { createServer } from 'node:http';
import type { RequestListener, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { FanoClient } from '../src/client.js';

async function listen(handler: RequestListener): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}

it('rejects redirects before sending the key or payload to another origin', async () => {
  let redirectedRequests = 0;
  let sourceRequests = 0;
  const destination = await listen((request, response) => {
    redirectedRequests += 1;
    request.resume();
    response.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
    response.end(JSON.stringify({ status: 'success', equilibrium_valid: true, results: [] }));
  });
  try {
    const source = await listen((request, response) => {
      sourceRequests += 1;
      request.resume();
      response.writeHead(307, { Location: destination.url, Connection: 'close' });
      response.end();
    });
    try {
      const client = new FanoClient({ baseUrl: source.url, apiKey: 'fabricated-test-value', timeoutMs: 1000 });
      await expect(client.ingestTrialBalance({ entity_structure: 'company', lines: [] })).rejects.toThrow();
      expect(sourceRequests).toBe(1);
      expect(redirectedRequests).toBe(0);
    } finally {
      await close(source.server);
    }
  } finally {
    await close(destination.server);
  }
});
