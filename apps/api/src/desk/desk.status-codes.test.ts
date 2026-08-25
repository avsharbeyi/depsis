import { HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import type { AuthenticatedRequest } from '../auth/session.guard.js';
import { NotesController } from './notes.controller.js';
import type { NotesService } from './notes.service.js';
import type { TaskCommentsService } from './task-comments.service.js';
import type { TaskWatchersService } from './task-watchers.service.js';
import { TasksController } from './tasks.controller.js';
import type { TaskFilesService } from './task-files.service.js';
import type { TasksService } from './tasks.service.js';

/**
 * The status code a rejected patch answers, locked against the published contract.
 *
 * Not an integration test, and that is the point: nothing here reaches the database, because the
 * fact being pinned is not a fact about data. `depsis.yaml` publishes 200, 404 and 422 for
 * `PATCH /notes/{id}` and `PATCH /tasks/{id}` and nothing else, so a client generated from it has
 * no branch for any other code. Both handlers answered 400 once — the same 201-character title
 * that POST refuses with 422 came back from PATCH as a status the client cannot name. The two
 * assertions below are what stop that from being reintroduced by a refactor that only reads the
 * code and not the document.
 *
 * The services are stubs that throw, so a regression that reached them would fail loudly rather
 * than quietly pass by taking a different path to a plausible answer.
 */

const NEVER_CALLED = {
  update: (): never => {
    throw new Error('validation should have refused this before the service was reached');
  },
};

const notes = new NotesController(NEVER_CALLED as unknown as NotesService);
// `NEVER_CALLED` ikisi için de: bu süit yalnız gövde doğrulamasının hangi durum kodunu
// ürettiğini ölçüyor, ve doğrulama servislerden ÖNCE koşuyor — bir çağrı gelirse test
// zaten yanlış şeyi ölçüyordur.
const tasks = new TasksController(
  NEVER_CALLED as unknown as TasksService,
  NEVER_CALLED as unknown as TaskFilesService,
  NEVER_CALLED as unknown as TaskCommentsService,
  NEVER_CALLED as unknown as TaskWatchersService,
);

/** A resolved session, which the handlers require before they look at the body. */
function signedIn(): AuthenticatedRequest {
  return {
    depsis: {
      organizationId: '00000000-0000-4000-8000-000000000001',
      userId: '00000000-0000-4000-8000-000000000002',
      role: 'member',
    },
  } as unknown as AuthenticatedRequest;
}

const ID = '00000000-0000-4000-8000-0000000000ff';

async function statusOf(call: Promise<unknown>): Promise<number> {
  try {
    await call;
  } catch (error) {
    if (error instanceof HttpException) return error.getStatus();
    throw error;
  }
  throw new Error('the call was expected to be refused and was not');
}

describe('PATCH refusals use the codes the contract publishes', () => {
  it('answers 422 for a note title past the 200-character cap, as POST /notes does', async () => {
    const tooLong = { title: 'x'.repeat(201) };
    expect(await statusOf(notes.update(signedIn(), ID, tooLong))).toBe(422);
  });

  it('answers 422 for an empty note patch, not 400', async () => {
    // `minProperties` has no code of its own in the contract, which is the reason 400 was chosen
    // here originally. The contract's answer is that this operation publishes exactly one code for
    // a body it will not accept.
    expect(await statusOf(notes.update(signedIn(), ID, {}))).toBe(422);
  });

  it('answers 422 for a task body past the 2000-character cap, as POST /tasks does', async () => {
    const tooLong = { body: 'x'.repeat(2001) };
    expect(await statusOf(tasks.update(signedIn(), ID, tooLong))).toBe(422);
  });

  it('answers 422 for an empty task patch, not 400', async () => {
    expect(await statusOf(tasks.update(signedIn(), ID, {}))).toBe(422);
  });

  it('still answers 404 for an id that is not a uuid, before it looks at the body', async () => {
    // The ordering matters and is easy to invert while editing the branch above: a mistyped URL is
    // "no such note", and answering 422 for it would report a bad body for a request whose body
    // was never the problem.
    expect(await statusOf(notes.update(signedIn(), 'not-a-uuid', {}))).toBe(404);
    expect(await statusOf(tasks.update(signedIn(), 'not-a-uuid', {}))).toBe(404);
  });
});
