import type { StorageAdapter, StorageRecord, WriteBatch } from "./adapter";

export interface IdbAdapterOptions {
  /** Name of the database */
  name: string;
  /** Another IndexedDB, for tests or special environments. `indexedDB` of the page by default */
  factory?: IDBFactory;
}

const request = <T>(req: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () =>
      reject(tx.error ?? new Error("The IndexedDB transaction was aborted"));
  });
}

/**
 * Opens the database. Without a version it opens the current one. `upgrade` creates tables
 * and is called only when the version is higher than the current one
 */
function openDatabase(
  factory: IDBFactory,
  name: string,
  version?: number,
  upgrade?: (db: IDBDatabase) => void
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(name, version);
    req.onupgradeneeded = () => upgrade?.(req.result);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * A thin promise wrapper around IndexedDB. Every table is an object store, keys are strings.
 * Tables are created when they are first asked for, the version of the database is managed here:
 * it grows when a table has to be added
 */
export function idbAdapter(options: IdbAdapterOptions): StorageAdapter {
  let db: IDBDatabase | null = null;
  let tables: readonly string[] = [];

  const factory = () => {
    const found =
      options.factory ??
      (typeof indexedDB !== "undefined" ? indexedDB : undefined);
    if (!found) throw new Error("IndexedDB is not available here");
    return found;
  };

  const connect = async (): Promise<IDBDatabase> => {
    const idb = factory();
    let opened = await openDatabase(idb, options.name);
    const missing = tables.filter((t) => !opened.objectStoreNames.contains(t));
    if (missing.length > 0) {
      const next = opened.version + 1;
      opened.close();
      opened = await openDatabase(idb, options.name, next, (created) => {
        missing.forEach((t) => {
          if (!created.objectStoreNames.contains(t)) created.createObjectStore(t);
        });
      });
    }
    // another tab wants to upgrade the database: let it, we open again when needed
    opened.onversionchange = () => {
      opened.close();
      if (db === opened) db = null;
    };
    return opened;
  };

  const database = async () => (db ??= await connect());

  return {
    async open(names) {
      tables = names;
      db = await connect();
    },

    async readAll(table): Promise<StorageRecord[]> {
      const tx = (await database()).transaction(table, "readonly");
      const store = tx.objectStore(table);
      const [keys, values] = await Promise.all([
        request(store.getAllKeys()),
        request(store.getAll()),
      ]);
      return keys.map((key, i) => ({ key: String(key), value: values[i] }));
    },

    async readKeys(table, keys) {
      const tx = (await database()).transaction(table, "readonly");
      const store = tx.objectStore(table);
      return Promise.all(keys.map((key) => request(store.get(key))));
    },

    async write(batches: readonly WriteBatch[]) {
      if (batches.length === 0) return;
      const names = [...new Set(batches.map((b) => b.table))];
      const tx = (await database()).transaction(names, "readwrite");
      const done = finished(tx);
      try {
        for (const batch of batches) {
          const store = tx.objectStore(batch.table);
          if (batch.clear) store.clear();
          for (const { key, value } of batch.puts ?? []) store.put(value, key);
          for (const key of batch.deletes ?? []) store.delete(key);
        }
      } catch (error) {
        // for example a value that can not be cloned: nothing of the transaction is written
        try {
          tx.abort();
        } catch {
          /* already finished */
        }
        await done.catch(() => undefined);
        throw error;
      }
      await done;
    },

    async clear() {
      const idb = await database();
      const names = Array.from(idb.objectStoreNames);
      if (names.length === 0) return;
      const tx = idb.transaction(names, "readwrite");
      const done = finished(tx);
      names.forEach((n) => tx.objectStore(n).clear());
      await done;
    },

    close() {
      db?.close();
      db = null;
    },
  };
}
