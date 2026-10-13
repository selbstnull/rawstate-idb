import { IDBFactory } from "fake-indexeddb";
import {
  createCollection,
  createSlice,
  createStore,
  increment,
  relation,
} from "rawstate-core";
import type { StorageAdapter } from "../adapter";
import { createMemoryStorage, memoryAdapter } from "../memory";
import { persistStore, type Persistence } from "../persist";
import { until } from "./helpers";

interface User { id: string; name: string; debt: number }
interface Credit { id: number; userId: string; amount: number }

const build = () => {
  const users = createCollection<User>()({ key: "id" });
  const credits = createCollection<Credit>()({ key: "id" });
  const settings = createSlice({
    state: { theme: "light", token: "", count: 0 },
    actions: {
      setTheme: (_s, theme: string) => ({ theme }),
      setToken: (_s, token: string) => ({ token }),
      bump: (s) => ({ count: s.count + 1 }),
    },
  });
  const ui = createSlice({
    state: { open: false },
    actions: { toggle: (s) => ({ open: !s.open }) },
  });
  const store = createStore({ users, credits, settings, ui }, {
    relations: [relation(credits, "userId", users)],
    rules: [increment(users, "debt").from(credits, { to: (c) => c.userId, by: (c) => c.amount })],
  });
  return { users, credits, settings, ui, store };
};

const open = (adapter: StorageAdapter, extra: Partial<Parameters<typeof persistStore>[1]> = {}) => {
  const app = build();
  const persistence = persistStore(app.store, {
    name: "app",
    adapter,
    channel: false,
    debounceMs: 0,
    persist: { users: true, credits: true, settings: ["theme", "count"] },
    ...extra,
  } as never);
  return { ...app, persistence };
};

const opened: Persistence[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((p) => p.destroy()));
});
const start = async (adapter: StorageAdapter, extra = {}) => {
  const app = open(adapter, extra);
  opened.push(app.persistence);
  await app.persistence.ready;
  return app;
};

describe("saving and loading", () => {
  it("what changed is saved and comes back at the next start", async () => {
    const storage = createMemoryStorage();
    const first = await start(memoryAdapter(storage));
    first.users.actions.addMany([
      { id: "b", name: "B", debt: 0 },
      { id: "a", name: "A", debt: 0 },
    ]);
    first.settings.actions.setTheme("dark");
    first.settings.actions.bump();
    await first.persistence.flush();
    await first.persistence.destroy();

    const second = await start(memoryAdapter(storage));
    expect(second.users.all().map((u) => u.id)).toEqual(["b", "a"]);
    expect(second.settings.getState("theme").get()).toBe("dark");
    expect(second.settings.getState("count").get()).toBe(1);
  });

  it("number ids and the order of rows survive, removed rows stay removed", async () => {
    const storage = createMemoryStorage();
    const first = await start(memoryAdapter(storage));
    first.users.actions.add({ id: "u", name: "U", debt: 0 });
    first.credits.actions.addMany([
      { id: 3, userId: "u", amount: 1 },
      { id: 1, userId: "u", amount: 1 },
      { id: 2, userId: "u", amount: 1 },
    ]);
    first.credits.actions.remove(1);
    await first.persistence.flush();
    await first.persistence.destroy();

    const second = await start(memoryAdapter(storage));
    expect(second.credits.all().map((c) => c.id)).toEqual([3, 2]);
    expect(second.credits.get(3)?.userId).toBe("u");
  });

  it("only the chosen things are saved", async () => {
    const storage = createMemoryStorage();
    const first = await start(memoryAdapter(storage));
    first.settings.actions.setToken("secret");
    first.settings.actions.setTheme("dark");
    first.ui.actions.toggle();
    await first.persistence.flush();
    await first.persistence.destroy();

    const second = await start(memoryAdapter(storage));
    expect(second.settings.getState("theme").get()).toBe("dark");
    expect(second.settings.getState("token").get()).toBe("");
    expect(second.ui.getState("open").get()).toBe(false);
    expect(JSON.stringify([...storage.entries()].map(([k, v]) => [k, [...v]]))).not.toContain("secret");
  });

  it("loaded data is not saved again and does not run rules a second time", async () => {
    const storage = createMemoryStorage();
    const first = await start(memoryAdapter(storage));
    first.users.actions.add({ id: "u", name: "U", debt: 0 });
    first.credits.actions.add({ id: 1, userId: "u", amount: 10 });
    expect(first.users.get("u")?.debt).toBe(10);
    await first.persistence.flush();
    await first.persistence.destroy();

    const adapter = memoryAdapter(storage);
    const write = jest.spyOn(adapter, "write");
    const second = await start(adapter);
    await second.persistence.flush();

    expect(second.users.get("u")?.debt).toBe(10);
    // only the version is written at start if anything
    expect(write.mock.calls.filter(([b]) => b.some((x) => x.table.startsWith("c:")))).toHaveLength(0);
  });

  it("changes made close together are written in one go, the last value wins", async () => {
    const adapter = memoryAdapter();
    const write = jest.spyOn(adapter, "write");
    const app = await start(adapter, { debounceMs: 30 });
    write.mockClear();

    app.settings.actions.setTheme("a");
    app.settings.actions.setTheme("b");
    app.settings.actions.setTheme("c");
    app.users.actions.add({ id: "x", name: "X", debt: 0 });
    app.users.actions.remove("x");
    await app.persistence.flush();

    expect(write).toHaveBeenCalledTimes(1);
    const [batches] = write.mock.calls[0];
    const theme = batches.find((b) => b.table === "s:settings")!;
    expect(theme.puts).toEqual([{ key: "theme", value: "c" }]);
    expect(await adapter.readAll("c:users")).toEqual([]);
  });

  it("data from the server (remote) is saved, loaded and tab data is not", async () => {
    const storage = createMemoryStorage();
    const app = await start(memoryAdapter(storage));
    await app.users.syncFrom(async () => [{ id: "s", name: "Server", debt: 0 }]);
    app.store.apply({ collections: { users: { upserted: [{ id: "t", name: "Tab", debt: 0 }] } } }, { origin: "tab" });
    await app.persistence.flush();

    const saved = await memoryAdapter(storage).readAll("c:users");
    expect(saved.map((r) => r.key)).toEqual(["s"]);
  });

  it("status goes from loading to ready", async () => {
    const adapter = memoryAdapter();
    const app = open(adapter);
    opened.push(app.persistence);
    const seen: string[] = [app.persistence.status.get()];
    app.persistence.status.subscribe((s) => seen.push(s));
    await app.persistence.ready;
    expect(seen).toEqual(["loading", "ready"]);
  });

  it("changes made while loading are put on top of the loaded data and saved", async () => {
    const storage = createMemoryStorage();
    const first = await start(memoryAdapter(storage));
    first.users.actions.add({ id: "old", name: "Old", debt: 0 });
    await first.persistence.flush();
    await first.persistence.destroy();

    const second = open(memoryAdapter(storage));
    opened.push(second.persistence);
    second.users.actions.add({ id: "early", name: "Early", debt: 0 });
    await second.persistence.ready;
    await second.persistence.flush();

    expect(second.users.all().map((u) => u.id).sort()).toEqual(["early", "old"]);
    const saved = await memoryAdapter(storage).readAll("c:users");
    expect(saved.map((r) => r.key).sort()).toEqual(["early", "old"]);
  });

  it("clear removes the saved data and the store stays", async () => {
    const storage = createMemoryStorage();
    const first = await start(memoryAdapter(storage));
    first.users.actions.add({ id: "a", name: "A", debt: 0 });
    await first.persistence.flush();
    await first.persistence.clear();
    expect(first.users.has("a")).toBe(true);
    await first.persistence.destroy();

    const second = await start(memoryAdapter(storage));
    expect(second.users.size.get()).toBe(0);
  });
});

describe("versions", () => {
  const seed = async (storage: ReturnType<typeof createMemoryStorage>, version: number) => {
    const first = await start(memoryAdapter(storage), { version });
    first.users.actions.add({ id: "a", name: "A", debt: 1 });
    await first.persistence.flush();
    await first.persistence.destroy();
  };

  it("migrate turns old data into the new shape", async () => {
    const storage = createMemoryStorage();
    await seed(storage, 1);
    const migrate = jest.fn((from: number, data: { collections?: Record<string, readonly object[]> }) => ({
      collections: {
        users: (data.collections?.users ?? []).map((u) => ({ ...u, name: `${(u as User).name}!` })),
      },
    }));

    const second = await start(memoryAdapter(storage), { version: 2, migrate });
    expect(migrate).toHaveBeenCalledWith(1, expect.anything());
    expect(second.users.get("a")?.name).toBe("A!");
    await second.persistence.destroy();

    const third = await start(memoryAdapter(storage), { version: 2, migrate });
    expect(migrate).toHaveBeenCalledTimes(1);
    expect(third.users.get("a")?.name).toBe("A!");
  });

  it("old data without migrate is thrown away", async () => {
    const storage = createMemoryStorage();
    await seed(storage, 1);
    const second = await start(memoryAdapter(storage), { version: 2 });
    expect(second.users.size.get()).toBe(0);
  });

  it("data of a newer version is thrown away, or it is an error", async () => {
    const storage = createMemoryStorage();
    await seed(storage, 3);
    const reset = await start(memoryAdapter(storage), { version: 2 });
    expect(reset.users.size.get()).toBe(0);
    await reset.persistence.destroy();

    const storage2 = createMemoryStorage();
    await seed(storage2, 3);
    const app = open(memoryAdapter(storage2), { version: 2, onDowngrade: "error" });
    opened.push(app.persistence);
    await expect(app.persistence.ready).rejects.toThrow("version 3");
    expect(app.persistence.status.get()).toBe("error");
  });

  it("data that does not fit the store is thrown away and the app starts", async () => {
    const storage = createMemoryStorage();
    const adapter = memoryAdapter(storage);
    await adapter.open(["meta", "c:users"]);
    await adapter.write([
      { table: "meta", puts: [{ key: "version", value: 1 }] },
      { table: "c:users", puts: [{ key: "x", value: { name: "no id" } }] },
    ]);
    const onError = jest.fn();

    const app = await start(memoryAdapter(storage), { onError });

    expect(onError).toHaveBeenCalledWith(expect.anything(), "hydrate");
    expect(app.users.size.get()).toBe(0);
    expect(app.persistence.status.get()).toBe("ready");
  });
});

describe("when storage fails", () => {
  it("without IndexedDB the app works in memory", async () => {
    const onError = jest.fn();
    const broken = {
      open() {
        throw new Error("SecurityError");
      },
    } as unknown as IDBFactory;
    const app = open(undefined as never, { adapter: undefined, indexedDB: broken, onError });
    opened.push(app.persistence);
    await app.persistence.ready;

    expect(app.persistence.persistent).toBe(false);
    expect(onError).toHaveBeenCalledWith(expect.anything(), "open");
    app.users.actions.add({ id: "a", name: "A", debt: 0 });
    await app.persistence.flush();
    expect(app.users.has("a")).toBe(true);
  });

  it("an adapter given by the user that fails is an error", async () => {
    const adapter = memoryAdapter();
    adapter.open = async () => {
      throw new Error("disk");
    };
    const app = open(adapter);
    opened.push(app.persistence);
    await expect(app.persistence.ready).rejects.toThrow("disk");
    expect(app.persistence.status.get()).toBe("error");
  });

  it("a failed write is reported and the store is not affected", async () => {
    const adapter = memoryAdapter();
    const onError = jest.fn();
    const app = await start(adapter, { onError });
    adapter.write = async () => {
      throw new Error("QuotaExceededError");
    };
    app.users.actions.add({ id: "a", name: "A", debt: 0 });
    await app.persistence.flush();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "QuotaExceededError" }), "write");
    expect(app.users.has("a")).toBe(true);
  });
});

describe("setup errors", () => {
  it("unknown names and states are errors", () => {
    const app = build();
    expect(() =>
      persistStore(app.store, { name: "x", adapter: memoryAdapter(), channel: false, persist: { nope: true } } as never)
    ).toThrow('no slice or collection "nope"');
    expect(() =>
      persistStore(app.store, { name: "x", adapter: memoryAdapter(), channel: false, persist: { settings: ["nope"] } } as never)
    ).toThrow('no state "settings.nope"');
  });

  it("the selection is checked by types", () => {
    const app = build();
    const check = (_fn: () => void) => {};
    check(() => {
      persistStore(app.store, { name: "x", persist: { users: true, settings: ["theme"] } });
      // @ts-expect-error there is no such slice
      persistStore(app.store, { name: "x", persist: { nope: true } });
      // @ts-expect-error there is no such state in settings
      persistStore(app.store, { name: "x", persist: { settings: ["nope"] } });
      // @ts-expect-error a collection is kept whole
      persistStore(app.store, { name: "x", persist: { users: ["id"] } });
    });
  });
});

describe("indexedDB end to end", () => {
  it("saves to IndexedDB and loads from it", async () => {
    const factory = new IDBFactory();
    const first = await start(undefined as never, { adapter: undefined, indexedDB: factory });
    first.users.actions.add({ id: "a", name: "A", debt: 0 });
    first.settings.actions.setTheme("dark");
    await first.persistence.flush();
    await first.persistence.destroy();

    const second = await start(undefined as never, { adapter: undefined, indexedDB: factory });
    expect(second.persistence.persistent).toBe(true);
    expect(second.users.get("a")?.name).toBe("A");
    expect(second.settings.getState("theme").get()).toBe("dark");
  });
});

describe("tabs", () => {
  const tab = async (factory: IDBFactory) => {
    const app = open(undefined as never, { adapter: undefined, indexedDB: factory, channel: true });
    opened.push(app.persistence);
    await app.persistence.ready;
    return app;
  };

  it("a change in one tab shows up in the other, in the right order", async () => {
    const factory = new IDBFactory();
    const a = await tab(factory);
    const b = await tab(factory);

    a.users.actions.addMany([
      { id: "x", name: "X", debt: 0 },
      { id: "y", name: "Y", debt: 0 },
    ]);
    a.settings.actions.setTheme("dark");
    await a.persistence.flush();

    await until(() => b.users.size.get() === 2 && b.settings.getState("theme").get() === "dark");
    expect(b.users.all().map((u) => u.id)).toEqual(["x", "y"]);

    a.users.actions.remove("x");
    await a.persistence.flush();
    await until(() => b.users.size.get() === 1);
    expect(b.users.all().map((u) => u.id)).toEqual(["y"]);
  });

  it("the other tab does not write it back and does not run rules again", async () => {
    const factory = new IDBFactory();
    const a = await tab(factory);
    const b = await tab(factory);
    const events: string[] = [];
    b.store.onCommit((e) => events.push(e.origin));

    a.users.actions.add({ id: "u", name: "U", debt: 0 });
    a.credits.actions.add({ id: 1, userId: "u", amount: 10 });
    await a.persistence.flush();
    await until(() => b.credits.has(1) && b.users.has("u"));
    await until(() => b.users.get("u")?.debt === 10);
    await b.persistence.flush();

    expect(b.users.get("u")?.debt).toBe(10);
    expect(events.every((o) => o === "tab")).toBe(true);
  });

  it("both tabs can change data and end up the same", async () => {
    const factory = new IDBFactory();
    const a = await tab(factory);
    const b = await tab(factory);

    a.users.actions.add({ id: "fromA", name: "A", debt: 0 });
    await a.persistence.flush();
    await until(() => b.users.has("fromA"));
    b.users.actions.add({ id: "fromB", name: "B", debt: 0 });
    await b.persistence.flush();
    await until(() => a.users.has("fromB"));

    expect(a.users.all().map((u) => u.id)).toEqual(b.users.all().map((u) => u.id));
  });
});

describe("disposing the store", () => {
  it("writes what is left and stops the persistence", async () => {
    const storage = createMemoryStorage();
    const app = open(memoryAdapter(storage), { debounceMs: 1000 });
    await app.persistence.ready;
    app.users.actions.add({ id: "last", name: "L", debt: 0 });

    app.store.dispose();
    await app.persistence.destroy();

    expect((await memoryAdapter(storage).readAll("c:users")).map((r) => r.key)).toEqual(["last"]);
    // a second destroy is fine
    await app.persistence.destroy();
  });

  it("a store disposed while the data is loading does not wipe what was saved", async () => {
    const storage = createMemoryStorage();
    const first = await start(memoryAdapter(storage));
    first.users.actions.add({ id: "keep", name: "K", debt: 0 });
    await first.persistence.flush();
    await first.persistence.destroy();

    const second = open(memoryAdapter(storage));
    second.store.dispose();
    await second.persistence.ready;
    await second.persistence.destroy();

    expect((await memoryAdapter(storage).readAll("c:users")).map((r) => r.key)).toEqual(["keep"]);
  });
});
