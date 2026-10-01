import type { Config } from '../config.js';
import { SingleAccount, type Accounts } from '../accounts.js';
import type { LinkedInClient } from './client.js';
import { LiveLinkedIn } from './live.js';
import { MockLinkedIn } from './mock.js';
import { createTokenStore, organizationUrnFromConfig } from './oauth.js';

export * from './client.js';
export { MockLinkedIn, MockScenarioSchema, type MockScenario } from './mock.js';
export { LiveLinkedIn } from './live.js';
export * from './oauth.js';

export function createLinkedInClient(config: Config, accounts: Accounts = new SingleAccount(createTokenStore(config))): LinkedInClient {
  if (config.mode === 'mock') {
    return new MockLinkedIn({ stateFile: config.paths.mockStateFile, scenarioFile: config.paths.mockScenarioFile });
  }
  return new LiveLinkedIn({
    accounts,
    organizationUrn: organizationUrnFromConfig(config),
    apiBase: config.linkedin.apiBase,
    apiVersion: config.linkedin.apiVersion,
  });
}
