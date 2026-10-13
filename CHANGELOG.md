# Changelog

## 0.1.0

The first release.

- `persistStore(store, options)`: saves the chosen collections and slices to IndexedDB, loads them at start, writes changes in atomic batches.
- Versions of the saved data and `migrate`; data that does not fit the store or its schemas is thrown away like any broken cache.
- Tabs keep each other up to date through BroadcastChannel.
- Works in memory when IndexedDB is not available.
- `idbAdapter` (a thin promise wrapper around IndexedDB), `memoryAdapter`, and the `StorageAdapter` interface for your own storage.
