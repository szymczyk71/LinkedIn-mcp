import type { Config } from '../config.js';
import type { LinkedInClient } from './client.js';
import { MockLinkedIn } from './mock.js';

export * from './client.js';
export { MockLinkedIn, MockScenarioSchema, type MockScenario } from './mock.js';

export function createLinkedInClient(config: Config): LinkedInClient {
  if (config.mode === 'mock') {
    return new MockLinkedIn({ stateFile: config.paths.mockStateFile, scenarioFile: config.paths.mockScenarioFile });
  }
  // Etap 5: prawdziwa implementacja (OAuth + Posts API). Do tego czasu tryb live jest zablokowany.
  throw new Error('Tryb live nie jest jeszcze zaimplementowany (etap 5). Ustaw LINKEDIN_MODE=mock.');
}
