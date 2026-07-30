/**
 * The one connection to the local buffer database.
 *
 * Shared by `drafts.ts` and `outbox.ts` and by nothing else. It is deliberately not exported
 * to the UI: before the cutover `App.tsx` opened the database itself to run a six-store wipe
 * (`App.tsx:801` in the pre-cutover file), and that is exactly the kind of reach-through that
 * makes "IndexedDB is only a buffer" a comment rather than a fact. Everything above this layer
 * talks to the server through `src/api/`.
 */

import { DB_NAME, openFitnessDB, type Database } from './schema.js';

let dbPromise: Promise<Database> | null = null;

export function getLocalDB(): Promise<Database> {
  // The handle is cached, so a connection the browser kills would otherwise poison every
  // later call. Dropping it here means the next call opens a fresh one instead.
  dbPromise ??= openFitnessDB(DB_NAME, {
    onTerminated: () => {
      dbPromise = null;
    },
  });
  return dbPromise;
}

/** Test seam — lets suites point at a fresh database. */
export function __setDB(promise: Promise<Database> | null): void {
  dbPromise = promise;
}

/**
 * Ask the browser to stop evicting this origin.
 *
 * Best-effort by nature: Safari grants or refuses on its own criteria and there is no appeal.
 * The answer is reported rather than acted on, because the honest thing to tell someone with an
 * unsent workout is whether the storage holding it is protected — see the README.
 *
 * Never throws. A browser without the Storage API is a browser where the answer is "unknown",
 * which is not a reason to fail a page load.
 */
export async function requestPersistentStorage(): Promise<boolean | undefined> {
  try {
    const storage = navigator.storage as StorageManager | undefined;
    if (storage?.persist === undefined) return undefined;
    if (storage.persisted !== undefined && (await storage.persisted())) return true;
    return await storage.persist();
  } catch {
    return undefined;
  }
}
