import {
  Collection,
  Observer,
  Slice,
  type CollectionLike,
  type CommitEvent,
  type Readable,
  type SliceLike,
  type Store,
  type StoreChanges,
  type StoreSnapshot,
  type TransactionDefs,
} from "rawstate-core";
import type { StorageAdapter, StorageRecord, WriteBatch } from "./adapter";
import { idbAdapter } from "./idb";
import { memoryAdapter } from "./memory";

/**
 * What of the store is kept in storage: by the name of the slice in the store.
 * A collection is kept whole (`true`), for a slice you can name the states to keep
 */
export type PersistSelection<T extends Record<string, SliceLike>> = {
  [K in keyof T]?: T[K] extends CollectionLike
    ? true
    : T[K] extends { snapshot(): infer Snapshot }
    ? true | readonly (keyof Snapshot & string)[]
    : true;
};

export type PersistenceStatus = "loading" | "ready" | "error";

export type PersistenceErrorPhase = "open" | "hydrate" | "write" | "tab";

export interface PersistOptions<T extends Record<string, SliceLike>> {
  /** Name of the database. Tabs that use the same name share the data */
  name: string;
  /** What to keep. Only what is named here is saved */
  persist: PersistSelection<T>;
  /**
   * Version of the shape of the saved data, 1 by default. Raise it when the shape changes
   * and write `migrate`. Without `migrate` old data is thrown away (it is a cache of the server)
   */
  version?: number;
  /** Turns data saved with `fromVersion` into data of the current version */
  migrate?: (
    fromVersion: number,
    data: StoreSnapshot
  ) => StoreSnapshot | Promise<StoreSnapshot>;
  /** What to do with data saved by a newer version of the app: throw it away (default) or fail */
  onDowngrade?: "reset" | "error";
  /** Where to keep the data. IndexedDB by default */
  adapter?: StorageAdapter;
  /** Another IndexedDB, for tests or special environments */
  indexedDB?: IDBFactory;
  /** Tell other tabs about changes with BroadcastChannel, `true` by default */
  channel?: boolean;
  /** How long to collect changes before writing them in one go, 20 ms by default */
  debounceMs?: number;
  /** Called when something fails. Failures do not break the store */
  onError?: (error: unknown, phase: PersistenceErrorPhase) => void;
}

export interface Persistence {
  /** `loading` until the saved data is in the store, then `ready` (or `error`) */
  readonly status: Readable<PersistenceStatus>;
  /** Resolved when the saved data is in the store, rejected if loading failed */
  readonly ready: Promise<void>;
  /** `false` if there is no storage and the data lives only in memory */
  readonly persistent: boolean;
  /** Waits until everything that changed is written */
  flush(): Promise<void>;
  /** Removes everything that was saved. The store stays as it is */
  clear(): Promise<void>;
  /** Writes what is left and stops watching the store */
  destroy(): Promise<void>;
}

interface Message {
  from: string;
  collections: Record<string, { keys: string[]; order: boolean }>;
  states: Record<string, string[]>;
}

const META = "meta";
const VERSION_KEY = "version";
const collectionTable = (name: string) => `c:${name}`;
const stateTable = (name: string) => `s:${name}`;
const orderKey = (name: string) => `order:${name}`;

type Id = string | number;

/**
 * Keeps the chosen collections and slices of the store in storage:
 * - at start the saved data is loaded into the store (`status` becomes `ready`)
 * - every change of the store is written, collected into one atomic write
 * - tabs that use the same database tell each other what changed
 *
 * Data that came from here (`hydrate`, `tab`) is not written back. Data from the server
 * (`remote`) is, so the next start shows it at once.
 */
export function persistStore<
  T extends Record<string, SliceLike>,
  X extends TransactionDefs<T>
>(store: Store<T, X>, options: PersistOptions<T>): Persistence {
  const version = options.version ?? 1;
  const debounceMs = options.debounceMs ?? 20;
  const report = (error: unknown, phase: PersistenceErrorPhase) => {
    try {
      options.onError?.(error, phase);
    } catch {
      /* a failing error handler must not break anything */
    }
  };

  // what is kept
  const collections = new Map<string, CollectionLike>();
  const states = new Map<string, readonly string[]>();
  for (const [name, selection] of Object.entries(options.persist) as [
    string,
    true | readonly string[] | undefined
  ][]) {
    if (!selection) continue;
    const slice = store.slices[name];
    if (!slice) throw new Error(`There is no slice or collection "${name}" in the store`);
    if (slice instanceof Collection) {
      collections.set(name, slice);
    } else if (slice instanceof Slice) {
      const known = Object.keys(slice.snapshot());
      const keys = selection === true ? known : selection;
      for (const key of keys) {
        if (!known.includes(key)) {
          throw new Error(`There is no state "${name}.${key}" in the store`);
        }
      }
      states.set(name, keys);
    } else {
      throw new Error(`"${name}" can not be kept: it is not a slice or a collection`);
    }
  }
  const tables = [
    META,
    ...[...collections.keys()].map(collectionTable),
    ...[...states.keys()].map(stateTable),
  ];

  const ownAdapter = options.adapter === undefined;
  let adapter: StorageAdapter =
    options.adapter ??
    idbAdapter({ name: options.name, factory: options.indexedDB });
  let persistent = true;
  const status = new Observer<PersistenceStatus>("loading");
  const tabId = Math.random().toString(36).slice(2);
  let destroyed = false;
  let destroying: Promise<void> | undefined;
  let hydrated = false;
  const waiting: CommitEvent[] = [];

  // ---------- reading ----------

  const readSnapshot = async (): Promise<StoreSnapshot> => {
    const snapshot: {
      collections: Record<string, readonly object[]>;
      states: Record<string, Record<string, unknown>>;
    } = { collections: {}, states: {} };

    for (const name of collections.keys()) {
      const [records, [order]] = await Promise.all([
        adapter.readAll(collectionTable(name)),
        adapter.readKeys(META, [orderKey(name)]),
      ]);
      if (records.length === 0 && order === undefined) continue;
      const byKey = new Map(records.map((r) => [r.key, r.value as object]));
      const ids = Array.isArray(order) ? (order as Id[]) : [];
      const rows: object[] = [];
      for (const id of ids) {
        const row = byKey.get(String(id));
        if (row) {
          rows.push(row);
          byKey.delete(String(id));
        }
      }
      // rows that are not in the order go to the end
      byKey.forEach((row) => rows.push(row));
      snapshot.collections[name] = rows;
    }
    for (const name of states.keys()) {
      const records = await adapter.readAll(stateTable(name));
      if (records.length === 0) continue;
      const allowed = states.get(name)!;
      snapshot.states[name] = Object.fromEntries(
        records.filter((r) => allowed.includes(r.key)).map((r) => [r.key, r.value])
      );
    }
    return snapshot;
  };

  const snapshotBatches = (snapshot: StoreSnapshot): WriteBatch[] => {
    const batches: WriteBatch[] = [
      { table: META, puts: [{ key: VERSION_KEY, value: version }] },
    ];
    for (const [name, rows] of Object.entries(snapshot.collections ?? {})) {
      const collection = collections.get(name);
      if (!collection) continue;
      const key = collection.key;
      batches.push({
        table: collectionTable(name),
        clear: true,
        puts: rows.map((row) => {
          const id = (row as Record<string, Id>)[key];
          return { key: String(id), value: row };
        }),
      });
      batches.push({
        table: META,
        puts: [
          {
            key: orderKey(name),
            value: rows.map((row) => (row as Record<string, Id>)[key]),
          },
        ],
      });
    }
    for (const [name, values] of Object.entries(snapshot.states ?? {})) {
      if (!states.has(name)) continue;
      batches.push({
        table: stateTable(name),
        clear: true,
        puts: Object.entries(values).map(([key, value]) => ({ key, value })),
      });
    }
    return batches;
  };

  const resetStorage = async () => {
    await adapter.clear();
    await adapter.write([
      { table: META, puts: [{ key: VERSION_KEY, value: version }] },
    ]);
  };

  // ---------- writing ----------

  const queued = new Map<string, Map<string, StorageRecord | null>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writing: Promise<void> = Promise.resolve();

  const enqueue = (table: string, key: string, record: StorageRecord | null) => {
    let target = queued.get(table);
    if (!target) queued.set(table, (target = new Map()));
    target.set(key, record);
  };

  const translate = (event: Pick<CommitEvent, "collections" | "states">) => {
    for (const [name, change] of Object.entries(event.collections)) {
      const collection = collections.get(name);
      if (!collection) continue;
      const table = collectionTable(name);
      for (const row of change.upserted) {
        const key = String((row as Record<string, Id>)[collection.key]);
        enqueue(table, key, { key, value: row });
      }
      for (const id of change.removed) enqueue(table, String(id), null);
      if (change.ids) {
        enqueue(META, orderKey(name), { key: orderKey(name), value: change.ids });
      }
    }
    for (const [name, values] of Object.entries(event.states)) {
      const allowed = states.get(name);
      if (!allowed) continue;
      for (const [key, value] of Object.entries(values)) {
        if (allowed.includes(key)) enqueue(stateTable(name), key, { key, value });
      }
    }
  };

  const notifyTabs = (batches: readonly WriteBatch[]) => {
    if (!channel) return;
    const message: Message = { from: tabId, collections: {}, states: {} };
    const keysOf = (b: WriteBatch) => [
      ...(b.puts ?? []).map((r) => r.key),
      ...(b.deletes ?? []),
    ];
    for (const batch of batches) {
      if (batch.table === META) {
        for (const key of keysOf(batch)) {
          if (key.startsWith("order:")) {
            const name = key.slice("order:".length);
            (message.collections[name] ??= { keys: [], order: false }).order = true;
          }
        }
      } else if (batch.table.startsWith("c:")) {
        const name = batch.table.slice(2);
        (message.collections[name] ??= { keys: [], order: false }).keys.push(
          ...keysOf(batch)
        );
      } else if (batch.table.startsWith("s:")) {
        const name = batch.table.slice(2);
        (message.states[name] ??= []).push(...keysOf(batch));
      }
    }
    channel.postMessage(message);
  };

  const drain = (): Promise<void> => {
    const batches: WriteBatch[] = [];
    for (const [table, records] of queued) {
      const puts: StorageRecord[] = [];
      const deletes: string[] = [];
      records.forEach((record, key) => (record ? puts.push(record) : deletes.push(key)));
      batches.push({ table, puts, deletes });
    }
    queued.clear();
    if (batches.length === 0) return writing;

    writing = writing.then(async () => {
      try {
        await adapter.write(batches);
        notifyTabs(batches);
      } catch (error) {
        report(error, "write");
      }
    });
    return writing;
  };

  const schedule = () => {
    if (timer !== undefined || destroyed) return;
    timer = setTimeout(() => {
      timer = undefined;
      void drain();
    }, debounceMs);
  };

  // ---------- tabs ----------

  const channel: BroadcastChannel | null =
    options.channel !== false && typeof BroadcastChannel !== "undefined"
      ? new BroadcastChannel(`rawstate-idb:${options.name}`)
      : null;
  let tabs: Promise<void> = Promise.resolve();

  const receive = async (message: Message) => {
    if (!message || message.from === tabId || destroyed) return;
    const changes: {
      collections: Record<string, { upserted: object[]; removed: string[]; ids?: Id[] }>;
      states: Record<string, Record<string, unknown>>;
    } = { collections: {}, states: {} };

    for (const [name, info] of Object.entries(message.collections ?? {})) {
      if (!collections.has(name)) continue;
      const values = await adapter.readKeys(collectionTable(name), info.keys);
      const change: { upserted: object[]; removed: string[]; ids?: Id[] } = {
        upserted: values.filter((v): v is object => v !== undefined),
        removed: info.keys.filter((_, i) => values[i] === undefined),
      };
      if (info.order) {
        const [order] = await adapter.readKeys(META, [orderKey(name)]);
        if (Array.isArray(order)) change.ids = order as Id[];
      }
      changes.collections[name] = change;
    }
    for (const [name, keys] of Object.entries(message.states ?? {})) {
      const allowed = states.get(name);
      if (!allowed) continue;
      const wanted = keys.filter((k) => allowed.includes(k));
      const values = await adapter.readKeys(stateTable(name), wanted);
      const found: Record<string, unknown> = {};
      wanted.forEach((key, i) => {
        if (values[i] !== undefined) found[key] = values[i];
      });
      changes.states[name] = found;
    }
    store.apply(changes as StoreChanges, { origin: "tab", trusted: true });
  };

  if (channel) {
    channel.onmessage = (e: MessageEvent<Message>) => {
      tabs = tabs
        .then(() => receive(e.data))
        .catch((error) => report(error, "tab"));
    };
  }

  // ---------- following the store ----------

  const unsubscribe = store.onCommit((event) => {
    if (event.origin === "hydrate" || event.origin === "tab") return;
    if (status.get() === "error") return;
    if (!hydrated) {
      waiting.push(event);
      return;
    }
    translate(event);
    schedule();
  });

  const lifecycle = () => {
    if (typeof document === "undefined" || document.visibilityState === "hidden") {
      void flush();
    }
  };
  const onHide = () => void flush();
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", lifecycle);
  }
  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("pagehide", onHide);
  }

  // ---------- start ----------

  const load = async () => {
    let snapshot: StoreSnapshot | null = null;
    try {
      await adapter.open(tables);
      const [stored] = await adapter.readKeys(META, [VERSION_KEY]);
      if (stored === undefined) {
        await adapter.write([
          { table: META, puts: [{ key: VERSION_KEY, value: version }] },
        ]);
      } else if (stored === version) {
        snapshot = await readSnapshot();
      } else if (typeof stored === "number" && stored < version) {
        if (options.migrate) {
          snapshot = await options.migrate(stored, await readSnapshot());
          await adapter.clear();
          await adapter.write(snapshotBatches(snapshot));
        } else {
          await resetStorage();
        }
      } else if (options.onDowngrade === "error") {
        throw new Error(
          `The data was saved by version ${String(stored)}, this is version ${version}`
        );
      } else {
        await resetStorage();
      }
    } catch (error) {
      report(error, "open");
      if (!ownAdapter) throw error;
      // no usable storage: work in memory, the app goes on
      adapter = memoryAdapter();
      persistent = false;
      await adapter.open(tables);
      snapshot = null;
    }

    // the store was disposed while the data was being read: there is nobody to load it into
    if (store.disposed) {
      hydrated = true;
      return;
    }

    if (snapshot) {
      try {
        store.load(snapshot);
      } catch (error) {
        // saved data does not fit the store: it is a cache, start from scratch
        report(error, "hydrate");
        await resetStorage();
      }
    }

    hydrated = true;
    // what changed while loading goes on top of the loaded data and is saved
    for (const event of waiting.splice(0)) {
      const kept: StoreChanges = {
        collections: Object.fromEntries(
          Object.entries(event.collections)
            .filter(([name]) => collections.has(name))
            .map(([name, c]) => [name, { upserted: c.upserted, removed: c.removed }])
        ),
        states: Object.fromEntries(
          Object.entries(event.states).filter(([name]) => states.has(name))
        ),
      };
      store.apply(kept, { origin: event.origin, trusted: true });
    }
  };

  // disposing the store stops the persistence: what is left is written, the database is closed
  store.onDispose(() => {
    void persistence.destroy().catch((error) => report(error, "write"));
  });

  const ready = load().then(
    () => {
      status.set("ready");
    },
    (error) => {
      status.set("error");
      throw error;
    }
  );
  ready.catch(() => undefined);
  // tabs are listened to only when the saved data is loaded
  tabs = ready.catch(() => undefined);

  async function flush(): Promise<void> {
    await ready.catch(() => undefined);
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    await drain();
    await writing;
  }

  const persistence: Persistence = {
    status,
    ready,
    get persistent() {
      return persistent;
    },
    flush,
    async clear() {
      await flush();
      await adapter.clear();
      await adapter.write([
        { table: META, puts: [{ key: VERSION_KEY, value: version }] },
      ]);
    },
    destroy() {
      return (destroying ??= (async () => {
        await flush();
        destroyed = true;
        unsubscribe();
        channel?.close();
        if (typeof document !== "undefined") {
          document.removeEventListener("visibilitychange", lifecycle);
        }
        if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
          window.removeEventListener("pagehide", onHide);
        }
        await tabs;
        adapter.close();
      })());
    },
  };
  return persistence;
}
