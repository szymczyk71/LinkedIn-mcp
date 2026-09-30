import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, type Config, type NewPost, type PlannedPost } from '../src/core/index.js';
import { newId, textHash } from '../src/core/util.js';

export function tmpDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'linkedin-mcp-test-'));
}

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({ LINKEDIN_MCP_DATA_DIR: tmpDataDir(), ...overrides }, { envFile: false });
}

export function plannedPost(seq: number, publishAtUtc: string, text = `Post testowy ${seq} ${newId('t')}`): PlannedPost {
  return {
    seq,
    text,
    textHash: textHash(text),
    publishAtUtc,
    timezone: 'Europe/Warsaw',
    commentText: 'Komentarz',
    linkMode: 'none',
    commentTextNoLink: null,
    ifNoLink: null,
    commentDelayMin: 10,
  };
}

export function toNewPost(p: PlannedPost, seriesId: string): NewPost {
  return {
    ...p,
    id: newId('post'),
    seriesId,
    status: 'scheduled',
    commentUrl: null,
    commentStatus: p.commentText ? 'waiting' : 'none',
    commentDueUtc: null,
    idempotencyKey: newId('idem'),
    linkedinPostUrn: null,
    postUrl: null,
    linkedinCommentUrn: null,
    publishedAtUtc: null,
    lastError: null,
    commentError: null,
  };
}
