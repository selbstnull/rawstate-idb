# rawstate-idb

Keeps a [rawstate](https://www.npmjs.com/package/rawstate) store in IndexedDB: the saved data is loaded at start, every change is written, and tabs keep each other up to date. IndexedDB here is a **cache of the server**: the app shows the saved data at once and the server data comes on top of it. **About 3 KB gzipped, no dependencies** (`rawstate` is a peer dependency).

```
npm i rawstate rawstate-idb
```

## Usage

```ts
import { createCollection, createSlice, createStore } from "rawstate";
import { persistStore } from "rawstate-idb";

const users = createCollection<User>()({ key: "id" });
const settings = createSlice({ state: { theme: "light", token: "" }, actions: { /* ... */ } });
const store = createStore({ users, settings });

const persistence = persistStore(store, {
  name: "my-app",                                   // name of the database
  persist: { users: true, settings: ["theme"] },    // only what is named here is saved
  version: 1,
});

await persistence.ready;                 // the saved data is in the store
await users.syncFrom(() => api.users()); // then bring fresh data from the server
```

`syncFrom` puts the answer of the server into the store and, because it is a change like any other, into IndexedDB. The next start shows it at once.

## What is saved and what is not

- **Only what you name** in `persist`: a whole collection (`true`) or chosen states of a slice (`["theme"]`). Tokens and temporary UI state stay out unless you name them. Names and keys are checked by types.
- **Where a change came from** decides what happens (see `origin` in rawstate):

| origin | saved | rules and relations |
| --- | --- | --- |
| `local` (your actions) | yes | run |
| `remote` (`syncFrom`, `store.apply`) | yes | not run, the data is trusted |
| `hydrate` (loading at start) | no | not run |
| `tab` (another tab) | no | not run |

Data that came from here is never written back, and rules are never run twice for data that already carries their result.

## Loading and status

`persistence.status` is `loading`, `ready` or `error`. It is a readable value, so in React:

```tsx
const status = useReadable(persistence.status);   // from rawstate-react
if (status === "loading") return <Spinner />;
```

Changes made before `ready` are put on top of the loaded data and saved.

## Writing

Changes are collected for `debounceMs` (20 ms) and written to IndexedDB in **one atomic transaction**: either all of them or none. The last value of a key wins. `await persistence.flush()` waits until everything is written, the page is also flushed when it is hidden or closed. Rows are saved one by one (by id), so only changed rows are written; the order of a collection is a separate small record.

A failed write (for example a full quota) is reported to `onError(error, "write")` and does not touch the store.

## Versions

Raise `version` when the shape of the saved data changes:

```ts
persistStore(store, {
  name: "my-app",
  version: 2,
  persist: { users: true },
  migrate: (fromVersion, data) => ({
    collections: { users: (data.collections?.users ?? []).map((u) => ({ ...u, role: "user" })) },
  }),
});
```

Without `migrate` old data is thrown away, because it is a cache. Data saved by a **newer** version is thrown away too, or it is an error with `onDowngrade: "error"`. Data that does not fit the store is thrown away and reported to `onError(error, "hydrate")`, the app starts anyway.

## Schemas

If your collections and slices have a `schema` (see rawstate), saved data is checked when it is loaded. Data of an old shape that does not fit is thrown away like any other broken cache (`onError(error, "hydrate")`, the app starts), unless `migrate` fixes it first. A change from another tab that does not fit is refused and reported (`onError(error, "tab")`), the tab keeps its data. Together with `version` and `migrate` this makes a change of the shape of your data safe.

## Tabs

Tabs that use the same `name` share the database. After a write a tab tells the others (BroadcastChannel) which keys changed, they read them and apply with origin `tab`. Both tabs end up with the same data, the last write wins. Turn it off with `channel: false`.

## When there is no storage

If IndexedDB can not be opened (a private window, blocked storage) the store works in memory, `persistence.persistent` is `false` and `onError(error, "open")` is called. Nothing breaks.

## Own storage

`persistStore` talks to a `StorageAdapter` (`open`, `readAll`, `readKeys`, atomic `write`, `clear`, `close`). IndexedDB (`idbAdapter`) is the default, `memoryAdapter` is for tests, and you can write your own.

## API

- `persistStore(store, options)` returns `{ status, ready, persistent, flush(), clear(), destroy() }`.
- `idbAdapter({ name, factory? })`, `memoryAdapter(storage?)`, `createMemoryStorage()`.

## Good to know

- It is a cache of the server, not a synchronisation engine: there are no versions of rows and no queue of local changes to send. If two tabs change the same row, the last write wins.
- The order of rows of a collection is saved as one record, so adding a row to a collection of very many rows rewrites that record.
- Data must be what IndexedDB can store (plain objects, arrays, dates, no functions or class instances).
- Disposing the store (`store.dispose()`) stops the persistence and writes what is left; you can also call `persistence.destroy()`.

## License

Apache-2.0
