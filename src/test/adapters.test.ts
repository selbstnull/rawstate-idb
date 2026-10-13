import { IDBFactory } from "fake-indexeddb";
import { idbAdapter } from "../idb";
import { createMemoryStorage, memoryAdapter } from "../memory";
import type { StorageAdapter } from "../adapter";

const adapters: [string, () => StorageAdapter][] = [
  ["memory", () => memoryAdapter()],
  ["indexedDB", () => idbAdapter({ name: "db", factory: new IDBFactory() })],
];

describe.each(adapters)("%s adapter", (_name, make) => {
  it("writes, reads all and reads by keys", async () => {
    const a = make();
    await a.open(["t", "u"]);
    await a.write([
      { table: "t", puts: [{ key: "1", value: { n: 1 } }, { key: "2", value: [2] }] },
      { table: "u", puts: [{ key: "x", value: "y" }] },
    ]);

    expect(await a.readAll("t")).toEqual([
      { key: "1", value: { n: 1 } },
      { key: "2", value: [2] },
    ]);
    expect(await a.readKeys("t", ["2", "nope", "1"])).toEqual([[2], undefined, { n: 1 }]);
    expect(await a.readAll("u")).toEqual([{ key: "x", value: "y" }]);
    a.close();
  });

  it("deletes, replaces and clears a table in a batch", async () => {
    const a = make();
    await a.open(["t"]);
    await a.write([{ table: "t", puts: [{ key: "1", value: 1 }, { key: "2", value: 2 }] }]);
    await a.write([{ table: "t", puts: [{ key: "1", value: 10 }], deletes: ["2"] }]);
    expect(await a.readAll("t")).toEqual([{ key: "1", value: 10 }]);

    await a.write([{ table: "t", clear: true, puts: [{ key: "9", value: 9 }] }]);
    expect(await a.readAll("t")).toEqual([{ key: "9", value: 9 }]);
    a.close();
  });

  it("a write is atomic: a value that can not be saved cancels everything", async () => {
    const a = make();
    await a.open(["t", "u"]);
    await a.write([{ table: "t", puts: [{ key: "keep", value: 1 }] }]);

    await expect(
      a.write([
        { table: "t", puts: [{ key: "new", value: 2 }], deletes: ["keep"] },
        { table: "u", puts: [{ key: "bad", value: () => 1 }] },
      ])
    ).rejects.toBeDefined();

    expect(await a.readAll("t")).toEqual([{ key: "keep", value: 1 }]);
    expect(await a.readAll("u")).toEqual([]);
    a.close();
  });

  it("clear removes everything from all tables", async () => {
    const a = make();
    await a.open(["t", "u"]);
    await a.write([
      { table: "t", puts: [{ key: "1", value: 1 }] },
      { table: "u", puts: [{ key: "1", value: 1 }] },
    ]);
    await a.clear();
    expect(await a.readAll("t")).toEqual([]);
    expect(await a.readAll("u")).toEqual([]);
    a.close();
  });

  it("saves dates and nested data like IndexedDB does", async () => {
    const a = make();
    await a.open(["t"]);
    await a.write([{ table: "t", puts: [{ key: "1", value: { at: new Date(5), list: [{ a: 1 }] } }] }]);
    const [{ value }] = await a.readAll("t");
    expect((value as { at: Date }).at).toEqual(new Date(5));
  });
});

describe("indexedDB adapter", () => {
  it("keeps data between openings and adds tables to an existing database", async () => {
    const factory = new IDBFactory();
    const first = idbAdapter({ name: "db", factory });
    await first.open(["t"]);
    await first.write([{ table: "t", puts: [{ key: "1", value: "kept" }] }]);
    first.close();

    const second = idbAdapter({ name: "db", factory });
    await second.open(["t", "later"]);
    expect(await second.readAll("t")).toEqual([{ key: "1", value: "kept" }]);
    await second.write([{ table: "later", puts: [{ key: "a", value: 1 }] }]);
    expect(await second.readAll("later")).toEqual([{ key: "a", value: 1 }]);
    second.close();
  });

  it("two connections can add tables one after another", async () => {
    const factory = new IDBFactory();
    const a = idbAdapter({ name: "db", factory });
    const b = idbAdapter({ name: "db", factory });
    await a.open(["one"]);
    await b.open(["two"]);
    await a.write([{ table: "one", puts: [{ key: "k", value: 1 }] }]);
    await b.write([{ table: "two", puts: [{ key: "k", value: 2 }] }]);
    expect(await a.readAll("one")).toHaveLength(1);
    expect(await b.readAll("two")).toHaveLength(1);
    a.close();
    b.close();
  });

  it("says clearly when there is no IndexedDB", async () => {
    const a = idbAdapter({ name: "db", factory: undefined });
    const saved = (globalThis as { indexedDB?: unknown }).indexedDB;
    delete (globalThis as { indexedDB?: unknown }).indexedDB;
    await expect(a.open(["t"])).rejects.toThrow("IndexedDB is not available");
    (globalThis as { indexedDB?: unknown }).indexedDB = saved;
  });
});

describe("memory adapter", () => {
  it("shares data between adapters that share the storage", async () => {
    const storage = createMemoryStorage();
    const a = memoryAdapter(storage);
    const b = memoryAdapter(storage);
    await a.open(["t"]);
    await a.write([{ table: "t", puts: [{ key: "1", value: 1 }] }]);
    expect(await b.readAll("t")).toEqual([{ key: "1", value: 1 }]);
  });
});
