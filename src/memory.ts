import type { StorageAdapter, StorageRecord, WriteBatch } from "./adapter";

/**
 * Tables of a memory storage. Give the same object to several adapters to share the data
 * like tabs of a browser share one database
 */
export type MemoryStorage = Map<string, Map<string, unknown>>;

export const createMemoryStorage = (): MemoryStorage => new Map();

/**
 * Keeps data in memory. It is for tests and for places where there is no IndexedDB.
 * Values are copied with `structuredClone` like IndexedDB does, so what can not be saved
 * to IndexedDB can not be saved here too
 */
export function memoryAdapter(
  storage: MemoryStorage = createMemoryStorage()
): StorageAdapter {
  const table = (name: string) => {
    let found = storage.get(name);
    if (!found) {
      found = new Map();
      storage.set(name, found);
    }
    return found;
  };

  return {
    async open(tables) {
      tables.forEach(table);
    },
    async readAll(name): Promise<StorageRecord[]> {
      return [...table(name)].map(([key, value]) => ({
        key,
        value: structuredClone(value),
      }));
    },
    async readKeys(name, keys) {
      const found = table(name);
      return keys.map((key) =>
        found.has(key) ? structuredClone(found.get(key)) : undefined
      );
    },
    async write(batches: readonly WriteBatch[]) {
      // everything is copied first: if something can not be cloned nothing is written
      const prepared = batches.map((batch) => ({
        batch,
        puts: (batch.puts ?? []).map(
          (record) => [record.key, structuredClone(record.value)] as const
        ),
      }));
      for (const { batch, puts } of prepared) {
        const target = table(batch.table);
        if (batch.clear) target.clear();
        puts.forEach(([key, value]) => target.set(key, value));
        (batch.deletes ?? []).forEach((key) => target.delete(key));
      }
    },
    async clear() {
      storage.forEach((tableData) => tableData.clear());
    },
    close() {},
  };
}
