/** LRU with both an entry limit and a caller-defined retained-size budget. */
export class BoundedCache<K, V> {
  private entries = new Map<K, { value: V; weight: number }>();
  private retainedWeight = 0;

  private maxEntries: number;
  private maxWeight: number;

  constructor(maxEntries: number, maxWeight: number) {
    this.maxEntries = maxEntries;
    this.maxWeight = maxWeight;
  }

  get size(): number { return this.entries.size; }
  get weight(): number { return this.retainedWeight; }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V, weight: number): void {
    this.delete(key);
    if (!Number.isFinite(weight) || weight < 0 || weight > this.maxWeight || this.maxEntries < 1) return;
    while (this.entries.size >= this.maxEntries || this.retainedWeight + weight > this.maxWeight) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }
    this.entries.set(key, { value, weight });
    this.retainedWeight += weight;
  }

  delete(key: K): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.retainedWeight -= entry.weight;
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.retainedWeight = 0;
  }
}
