/**
 * One record of a table
 */
export interface StorageRecord {
  readonly key: string;
  readonly value: unknown;
}

/**
 * Changes of one table: it can be cleared first, then records are put and deleted
 */
export interface WriteBatch {
  readonly table: string;
  readonly clear?: boolean;
  readonly puts?: readonly StorageRecord[];
  readonly deletes?: readonly string[];
}

/**
 * Where the data is kept. Every method is asynchronous, a call of `write` is atomic:
 * all the batches are written or none of them
 */
export interface StorageAdapter {
  /** Makes sure the tables exist. It is called once, before everything else */
  open(tables: readonly string[]): Promise<void>;
  /** All the records of the table */
  readAll(table: string): Promise<StorageRecord[]>;
  /** Values by keys, `undefined` for a key that is not there */
  readKeys(table: string, keys: readonly string[]): Promise<unknown[]>;
  write(batches: readonly WriteBatch[]): Promise<void>;
  /** Removes everything from all the tables */
  clear(): Promise<void>;
  close(): void;
}
