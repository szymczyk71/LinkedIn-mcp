import fs from 'node:fs';
import { z } from 'zod';
import { newId } from '../util.js';
import {
  LinkedInError,
  type AuthInfo,
  type CommentInput,
  type CommentResult,
  type LinkedInClient,
  type PublishInput,
  type PublishResult,
} from './client.js';

/**
 * Atrapa LinkedIn. Scenariusze błędów ustawia się programowo (setScenario) albo plikiem
 * mock-scenario.json w katalogu danych (czytany przy każdym wywołaniu, więc można go zmieniać
 * przy działającym workerze komendą `npm run cli -- mock ...`).
 *
 * W scenariuszach "timeout" i "ambiguous" atrapa NAJPIERW zapisuje obiekt, a dopiero potem zgłasza
 * błąd - to najgorszy przypadek (post powstał, ale my o tym nie wiemy), na którym testujemy brak duplikatów.
 */

export const PUBLISH_MODES = ['ok', 'reject', 'timeout', 'ambiguous', 'unauthorized', 'rate_limited', 'network'] as const;
export const COMMENT_MODES = ['ok', 'forbidden', 'reject', 'timeout', 'ambiguous', 'unauthorized'] as const;
export const AUTH_MODES = ['ok', 'disconnected', 'no_post_permission'] as const;

const opSchema = <T extends readonly [string, ...string[]]>(modes: T) =>
  z.union([z.enum(modes), z.object({ mode: z.enum(modes), times: z.number().int().positive().optional() })]);

export const MockScenarioSchema = z.object({
  auth: z.enum(AUTH_MODES).optional(),
  publish: opSchema(PUBLISH_MODES).optional(),
  comment: opSchema(COMMENT_MODES).optional(),
  /** Opóźnienie odpowiedzi w ms (np. do obserwowania statusu "publishing"). */
  delayMs: z.number().int().min(0).max(120_000).optional(),
});
export type MockScenario = z.infer<typeof MockScenarioSchema>;

export interface MockComment {
  urn: string;
  text: string;
  idempotencyKey: string;
  createdAt: string;
}

export interface MockPost {
  urn: string;
  text: string;
  idempotencyKey: string;
  createdAt: string;
  comments: MockComment[];
}

interface MockState {
  posts: MockPost[];
}

export interface MockOptions {
  stateFile?: string;
  scenarioFile?: string;
  scenario?: MockScenario;
  profileName?: string;
  expiresAt?: string;
}

export class MockLinkedIn implements LinkedInClient {
  readonly mode = 'mock' as const;
  private scenario: MockScenario;
  private state: MockState;
  /** Liczniki wywołań, przydatne w testach. */
  readonly calls = { checkAuth: 0, publishPost: 0, addComment: 0 };

  constructor(private readonly opts: MockOptions = {}) {
    this.scenario = MockScenarioSchema.parse(opts.scenario ?? {});
    this.state = this.loadState();
  }

  setScenario(s: MockScenario): void {
    this.scenario = MockScenarioSchema.parse(s);
  }

  /** Posty "opublikowane" w atrapie (także te po timeoucie). */
  get posts(): readonly MockPost[] {
    return this.state.posts;
  }

  async checkAuth(): Promise<AuthInfo> {
    this.calls.checkAuth++;
    const s = this.currentScenario();
    if (s.auth === 'disconnected') {
      return { connected: false, personUrn: null, profileName: null, profileUrl: null, expiresAt: null, scopes: [], canPost: false };
    }
    return {
      connected: true,
      personUrn: 'urn:li:person:MOCK123',
      profileName: this.opts.profileName ?? 'Szymon Warda (atrapa)',
      profileUrl: 'https://www.linkedin.com/in/mock-profile',
      expiresAt: this.opts.expiresAt ?? new Date(Date.now() + 60 * 86_400_000).toISOString(),
      scopes: s.auth === 'no_post_permission' ? ['openid', 'profile'] : ['openid', 'profile', 'w_member_social'],
      canPost: s.auth !== 'no_post_permission',
    };
  }

  async publishPost(input: PublishInput): Promise<PublishResult> {
    this.calls.publishPost++;
    const s = this.currentScenario();
    const mode = this.takeMode('publish', s);
    await this.delay(s);
    if (s.auth === 'disconnected') throw new LinkedInError('unauthorized', 'Atrapa: brak połączenia z LinkedIn.', 401);
    if (s.auth === 'no_post_permission') throw new LinkedInError('forbidden', 'Atrapa: brak uprawnienia w_member_social (403).', 403);
    switch (mode) {
      case 'reject':
        throw new LinkedInError('rejected', 'Atrapa: LinkedIn odrzucił post (422).', 422);
      case 'unauthorized':
        throw new LinkedInError('unauthorized', 'Atrapa: token wygasł lub jest nieważny (401).', 401);
      case 'rate_limited':
        throw new LinkedInError('rate_limited', 'Atrapa: przekroczony limit wywołań (429).', 429);
      case 'network':
        throw new LinkedInError('network', 'Atrapa: brak połączenia przed wysłaniem (ECONNREFUSED).');
      case 'timeout':
        this.createPost(input);
        throw new LinkedInError('timeout', 'Atrapa: brak odpowiedzi po wysłaniu posta (timeout).');
      case 'ambiguous':
        this.createPost(input);
        throw new LinkedInError('ambiguous', 'Atrapa: zerwane połączenie po wysłaniu posta (502).', 502);
      default: {
        const p = this.createPost(input);
        return { postUrn: p.urn, postUrl: mockPostUrl(p.urn) };
      }
    }
  }

  async addComment(input: CommentInput): Promise<CommentResult> {
    this.calls.addComment++;
    const s = this.currentScenario();
    const mode = this.takeMode('comment', s);
    await this.delay(s);
    const post = this.state.posts.find((p) => p.urn === input.postUrn);
    if (!post) throw new LinkedInError('rejected', `Atrapa: post ${input.postUrn} nie istnieje (404).`, 404);
    switch (mode) {
      case 'forbidden':
        throw new LinkedInError('forbidden', 'Atrapa: brak uprawnień do komentowania (403).', 403);
      case 'reject':
        throw new LinkedInError('rejected', 'Atrapa: LinkedIn odrzucił komentarz (422).', 422);
      case 'unauthorized':
        throw new LinkedInError('unauthorized', 'Atrapa: token wygasł lub jest nieważny (401).', 401);
      case 'timeout':
        this.createComment(post, input);
        throw new LinkedInError('timeout', 'Atrapa: brak odpowiedzi po wysłaniu komentarza (timeout).');
      case 'ambiguous':
        this.createComment(post, input);
        throw new LinkedInError('ambiguous', 'Atrapa: zerwane połączenie po wysłaniu komentarza (502).', 502);
      default:
        return { commentUrn: this.createComment(post, input) };
    }
  }

  private createPost(input: PublishInput): MockPost {
    const p: MockPost = {
      urn: `urn:li:share:${newId('mock')}`,
      text: input.text,
      idempotencyKey: input.idempotencyKey,
      createdAt: new Date().toISOString(),
      comments: [],
    };
    this.state.posts.push(p);
    this.saveState();
    return p;
  }

  private createComment(post: MockPost, input: CommentInput): string {
    const urn = `urn:li:comment:(${post.urn},${newId('c')})`;
    post.comments.push({ urn, text: input.text, idempotencyKey: input.idempotencyKey, createdAt: new Date().toISOString() });
    this.saveState();
    return urn;
  }

  private currentScenario(): MockScenario {
    const file = this.opts.scenarioFile;
    if (file && fs.existsSync(file)) {
      try {
        this.scenario = MockScenarioSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
      } catch {
        // Uszkodzony plik scenariusza: zostajemy przy poprzednim.
      }
    }
    return this.scenario;
  }

  /** Zwraca tryb operacji i zmniejsza licznik `times`; po wyczerpaniu wraca do "ok". */
  private takeMode(op: 'publish' | 'comment', s: MockScenario): string {
    const v = s[op];
    if (v === undefined) return 'ok';
    if (typeof v === 'string') return v;
    if (v.times === undefined) return v.mode;
    const next: MockScenario = { ...s };
    if (v.times <= 1) delete next[op];
    else next[op] = { mode: v.mode, times: v.times - 1 } as never;
    this.scenario = next;
    if (this.opts.scenarioFile) fs.writeFileSync(this.opts.scenarioFile, JSON.stringify(next, null, 2));
    return v.mode;
  }

  private async delay(s: MockScenario): Promise<void> {
    if (s.delayMs) await new Promise((r) => setTimeout(r, s.delayMs));
  }

  private loadState(): MockState {
    const f = this.opts.stateFile;
    if (f && fs.existsSync(f)) {
      try {
        return JSON.parse(fs.readFileSync(f, 'utf8')) as MockState;
      } catch {
        /* nowy stan */
      }
    }
    return { posts: [] };
  }

  private saveState(): void {
    if (this.opts.stateFile) fs.writeFileSync(this.opts.stateFile, JSON.stringify(this.state, null, 2));
  }
}

export function mockPostUrl(urn: string): string {
  return `https://www.linkedin.com/feed/update/${urn}/`;
}
