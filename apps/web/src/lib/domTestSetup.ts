// Node can supply a global localStorage getter even when its backing file is disabled.
// Give DOM tests their own browser storage.
if (typeof document !== "undefined") {
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: new Storage() });
}

// A DOM test runs on happy-dom's page at http://localhost:3000, so a request a test hasn't mocked would go out over the
// network there and fail with ECONNREFUSED, or reach whatever happens to listen on that port. No test reaches the
// network: such a request fails at once, as one the engine never answered does. A test that wants an answer mocks
// `api` or stubs `fetch` itself.
if (typeof document !== "undefined") {
  const pageFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (/^(https?|wss?):/i.test(new URL(url, location.href).protocol)) return Promise.reject(new TypeError("Failed to fetch"));
    return pageFetch(input, init);
  }) as typeof fetch;
}
