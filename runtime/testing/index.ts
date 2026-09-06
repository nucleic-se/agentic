/** Framework-neutral, deterministic adapter contract checks. No credentials or network required. */
export { assertProviderConformance } from './provider.js';
export type { ProviderScenario, ProviderScenarioFixture, ProviderScenarioFactory, ConformanceReport } from './provider.js';
export { assertSessionStoreConformance } from './store.js';
export type { SessionStoreFixture, SessionStoreFactory } from './store.js';
