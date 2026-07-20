/**
 * Polyfill newer JavaScript runtime APIs pdfjs 5.7 uses in its render path.
 * Electron 39's V8 (Chromium ~140) lacks Map upsert and Math.sumPrecise,
 * so `page.render()` can throw before the canvas is painted. Importing this
 * module installs the methods on both the main thread and the pdf worker
 * scope — see `pdfWorker.ts`.
 *
 * Remove once Electron's bundled Chromium ships these APIs.
 */
interface Math {
  sumPrecise?: (values: Iterable<number>) => number;
}

type AnyMap = Map<unknown, unknown> & {
  getOrInsert?: (key: unknown, value: unknown) => unknown;
  getOrInsertComputed?: (key: unknown, fn: (key: unknown) => unknown) => unknown;
};

function install(proto: AnyMap): void {
  if (typeof proto.getOrInsertComputed !== 'function') {
    Object.defineProperty(proto, 'getOrInsertComputed', {
      value(this: Map<unknown, unknown>, key: unknown, fn: (key: unknown) => unknown) {
        if (this.has(key)) return this.get(key);
        const v = fn(key);
        this.set(key, v);
        return v;
      },
      writable: true,
      configurable: true,
    });
  }
  if (typeof proto.getOrInsert !== 'function') {
    Object.defineProperty(proto, 'getOrInsert', {
      value(this: Map<unknown, unknown>, key: unknown, value: unknown) {
        if (this.has(key)) return this.get(key);
        this.set(key, value);
        return value;
      },
      writable: true,
      configurable: true,
    });
  }
}

install(Map.prototype as AnyMap);
install(WeakMap.prototype as unknown as AnyMap);

if (typeof Math.sumPrecise !== 'function') {
  Object.defineProperty(Math, 'sumPrecise', {
    value(values: Iterable<number>) {
      let sum = 0;
      let compensation = 0;
      for (const value of values) {
        const next = sum + value;
        if (Math.abs(sum) >= Math.abs(value)) {
          compensation += (sum - next) + value;
        } else {
          compensation += (value - next) + sum;
        }
        sum = next;
      }
      return sum + compensation;
    },
    writable: true,
    configurable: true,
  });
}
