import { createCollection, createSlice, createStore } from "rawstate-core";
import { z } from "zod";
import { createMemoryStorage, memoryAdapter } from "../memory";
import { persistStore } from "../persist";
import { until } from "./helpers";

const User = z.object({ id: z.string(), name: z.string(), age: z.number() });

const build = () => {
  const users = createCollection({ key: "id", schema: User });
  const settings = createSlice({
    state: { theme: "light" },
    actions: {},
    schema: z.object({ theme: z.enum(["light", "dark"]) }),
  });
  return { users, settings, store: createStore({ users, settings }) };
};

describe("persistence with schemas", () => {
  it("saved data that no longer fits the schema is thrown away and the app starts", async () => {
    const storage = createMemoryStorage();
    const seed = memoryAdapter(storage);
    await seed.open(["meta", "c:users", "s:settings"]);
    await seed.write([
      { table: "meta", puts: [{ key: "version", value: 1 }, { key: "order:users", value: ["a"] }] },
      // an old shape: "age" was a string then
      { table: "c:users", puts: [{ key: "a", value: { id: "a", name: "A", age: "30" } }] },
    ]);

    const app = build();
    const onError = jest.fn();
    const persistence = persistStore(app.store, {
      name: "app", adapter: memoryAdapter(storage), channel: false, debounceMs: 0, onError,
      persist: { users: true, settings: true },
    });
    await persistence.ready;

    expect(persistence.status.get()).toBe("ready");
    expect(app.users.size.get()).toBe(0);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ name: "ValidationError", source: "users" }), "hydrate");
    await persistence.destroy();
  });

  it("valid saved data is loaded as usual", async () => {
    const storage = createMemoryStorage();
    const first = build();
    const p1 = persistStore(first.store, { name: "app", adapter: memoryAdapter(storage), channel: false, debounceMs: 0, persist: { users: true } });
    await p1.ready;
    first.users.actions.add({ id: "a", name: "A", age: 3 });
    await p1.flush();
    await p1.destroy();

    const second = build();
    const p2 = persistStore(second.store, { name: "app", adapter: memoryAdapter(storage), channel: false, debounceMs: 0, persist: { users: true } });
    await p2.ready;
    expect(second.users.get("a")?.age).toBe(3);
    await p2.destroy();
  });

  it("a migration can fix old data before it is checked", async () => {
    const storage = createMemoryStorage();
    const seed = memoryAdapter(storage);
    await seed.open(["meta", "c:users"]);
    await seed.write([
      { table: "meta", puts: [{ key: "version", value: 1 }, { key: "order:users", value: ["a"] }] },
      { table: "c:users", puts: [{ key: "a", value: { id: "a", name: "A", age: "30" } }] },
    ]);

    const app = build();
    const persistence = persistStore(app.store, {
      name: "app", adapter: memoryAdapter(storage), channel: false, debounceMs: 0, version: 2,
      persist: { users: true },
      migrate: (_from, data) => ({
        collections: {
          users: (data.collections?.users ?? []).map((u) => ({ ...u, age: Number((u as { age: string }).age) })),
        },
      }),
    });
    await persistence.ready;
    expect(app.users.get("a")?.age).toBe(30);
    await persistence.destroy();
  });

  it("a bad change from another tab is refused and reported, the tab keeps its data", async () => {
    const { IDBFactory } = await import("fake-indexeddb");
    const factory = new IDBFactory();
    const mk = async () => {
      const app = build();
      const onError = jest.fn();
      const persistence = persistStore(app.store, { name: "app", indexedDB: factory, debounceMs: 0, persist: { users: true }, onError });
      await persistence.ready;
      return { ...app, persistence, onError };
    };
    const a = await mk();
    const b = await mk();

    a.users.actions.add({ id: "ok", name: "A", age: 1 });
    await a.persistence.flush();
    await until(() => b.users.has("ok"));

    // a tab with an older app version writes a row of an old shape
    a.users.actions.add({ id: "old", name: "A", age: "x" } as never);
    await a.persistence.flush();
    await until(() => b.onError.mock.calls.length > 0);

    expect(b.onError).toHaveBeenCalledWith(expect.objectContaining({ name: "ValidationError" }), "tab");
    expect(b.users.has("old")).toBe(false);
    expect(b.users.has("ok")).toBe(true);
    await a.persistence.destroy();
    await b.persistence.destroy();
  });
});
