import { describe, expect, it } from 'vitest';

import type {
  AclApplyService,
  AgentService,
  CopyService,
  IdentitySyncService,
  IndexerService,
  JobsService,
  TrashRetentionService,
} from '@depsis/api/worker-surface';

import { registerHandlers } from './registry.js';
import { WorkerService } from '../worker.service.js';

/**
 * The kinds this worker will actually claim.
 *
 * A list rather than a behaviour, and it earns its place because of how the gap showed up:
 * `PermissionsService` had been enqueuing `permissions.apply` since §6.2's endpoints were served,
 * every one of those rows was unclaimable because no handler was registered, and nothing failed.
 * The API's own test asserted a row landed on the queue; nothing asserted anybody would ever take
 * it off. Adding an enqueue without adding the consumer has to break something, and this is it.
 */
describe('the worker consumes every kind the API enqueues', () => {
  it('registers a handler for each one', () => {
    const worker = new WorkerService({ workerId: 'test' } as unknown as JobsService);
    registerHandlers(worker, {
      agent: {} as unknown as AgentService,
      acl: {} as unknown as AclApplyService,
      jobs: {} as unknown as JobsService,
      identity: {} as unknown as IdentitySyncService,
      copies: {} as unknown as CopyService,
      retention: {} as unknown as TrashRetentionService,
      indexer: {} as unknown as IndexerService,
    });
    expect(worker.kinds.sort()).toEqual([
      'files.copy',
      'files.reconcile',
      'files.trash.purge',
      'identity.sync',
      'permissions.apply',
      'storage.snapshot',
    ]);
  });
});
