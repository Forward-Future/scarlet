// Node can supply a global localStorage getter even when its backing file is disabled.
// Give DOM tests their own browser storage.
if (typeof document !== "undefined") {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: new Storage() });
}
