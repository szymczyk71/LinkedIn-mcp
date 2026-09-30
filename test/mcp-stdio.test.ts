import type { ChildProcess } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, describe, expect, it } from 'vitest';
import { STDIO_JS, freePort, isolatedEnv, startWorkerProcess } from './process-helpers.js';
import { tmpDataDir } from './helpers.js';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function connectClient(env: Record<string, string>): Promise<Client> {
  const transport = new StdioClientTransport({ command: process.execPath, args: [STDIO_JS], env, stderr: 'pipe' });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(transport);
  cleanups.push(() => client.close());
  return client;
}

function parse(result: Awaited<ReturnType<Client['callTool']>>): any {
  const first = (result.content as { type: string; text: string }[])[0]!;
  return JSON.parse(first.text);
}

/** Termin za ~2 dni w czasie lokalnym Warszawy, na pełnej godzinie. */
function localInDays(days: number, hour: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  const ymd = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return `${ymd}T${String(hour).padStart(2, '0')}:00:00`;
}

describe('nakładka stdio (klient MCP)', () => {
  it('udostępnia 8 narzędzi z kontraktu i obsługuje pełny przepływ podgląd -> zatwierdzenie -> kolejka', async () => {
    const dataDir = tmpDataDir();
    const port = await freePort();
    const env = isolatedEnv(dataDir, port);
    const worker: ChildProcess = await startWorkerProcess(env);
    cleanups.push(() => void worker.kill());
    const client = await connectClient(env);

    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(tools).toEqual(
      [
        'linkedin_auth_status',
        'linkedin_cancel_post',
        'linkedin_commit_series',
        'linkedin_get_post',
        'linkedin_list_queue',
        'linkedin_preview_series',
        'linkedin_set_comment_link',
        'linkedin_update_post',
      ].sort(),
    );
    expect(tools.some((t) => /publish_now|publish$/.test(t))).toBe(false);

    const auth = parse(await client.callTool({ name: 'linkedin_auth_status', arguments: {} }));
    expect(auth).toMatchObject({ connected: true, can_comment: 'unknown', mode: 'mock', login_url: `http://127.0.0.1:${port}/oauth/start` });

    const preview = parse(
      await client.callTool({
        name: 'linkedin_preview_series',
        arguments: {
          posts: [
            { text: 'Pierwszy post #MCP', publish_at: localInDays(2, 9), comment_text: 'Komentarz' },
            { text: 'Drugi post', publish_at: localInDays(3, 9), comment_text: 'Więcej: [LINK]', link_mode: 'later', if_no_link: 'skip' },
          ],
        },
      }),
    );
    expect(preview.summary.ready_to_commit).toBe(true);

    const commit = parse(await client.callTool({ name: 'linkedin_commit_series', arguments: { plan_id: preview.plan_id } }));
    expect(commit.posts).toHaveLength(2);

    const again = await client.callTool({ name: 'linkedin_commit_series', arguments: { plan_id: preview.plan_id } });
    expect(again.isError).toBe(true);
    expect(parse(again).error.code).toBe('plan_already_committed');

    const queue = parse(await client.callTool({ name: 'linkedin_list_queue', arguments: { status: 'scheduled' } }));
    expect(queue.count).toBe(2);

    const link = parse(
      await client.callTool({ name: 'linkedin_set_comment_link', arguments: { id: commit.posts[1].id, url: 'https://example.com/x' } }),
    );
    expect(link.comment_preview).toBe('Więcej: https://example.com/x');

    const upd = parse(await client.callTool({ name: 'linkedin_update_post', arguments: { id: commit.posts[0].id, text: 'Poprawiony post' } }));
    expect(upd.text).toBe('Poprawiony post');

    const cancel = parse(await client.callTool({ name: 'linkedin_cancel_post', arguments: { id: commit.posts[0].id } }));
    expect(cancel.status).toBe('canceled');

    const full = parse(await client.callTool({ name: 'linkedin_get_post', arguments: { id: commit.posts[0].id } }));
    expect(full.events.map((e: { type: string }) => e.type)).toEqual(['created', 'updated', 'canceled']);
  }, 60_000);

  it('gdy worker nie działa: czytelny błąd z komendą uruchomienia', async () => {
    const dataDir = tmpDataDir();
    const env = isolatedEnv(dataDir, await freePort());
    const client = await connectClient(env);
    const r = await client.callTool({ name: 'linkedin_list_queue', arguments: {} });
    expect(r.isError).toBe(true);
    const err = parse(r).error;
    expect(err.code).toBe('worker_not_running');
    expect(err.message).toMatch(/npm run worker/);
  }, 30_000);

  it('worker zatrzymany po starcie nakładki: błąd połączenia z komendą uruchomienia', async () => {
    const dataDir = tmpDataDir();
    const env = isolatedEnv(dataDir, await freePort());
    const worker = await startWorkerProcess(env);
    const client = await connectClient(env);
    expect((await client.callTool({ name: 'linkedin_list_queue', arguments: {} })).isError).toBeFalsy();
    worker.kill();
    await new Promise((r) => worker.once('exit', r));
    const r = await client.callTool({ name: 'linkedin_list_queue', arguments: {} });
    expect(parse(r).error).toMatchObject({ code: 'worker_not_running' });
    expect(parse(r).error.message).toMatch(/npm run worker/);
  }, 30_000);
});
