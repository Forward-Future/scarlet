/** A workspace bearer may cross a network only over TLS. URL parsing normalizes IPv4 and IPv6 literals. */
export function requireSecureEngineUrl(address: string): URL {
  const url = new URL(address);
  const local = url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  if (url.username || url.password || url.search || url.hash ||
      !(url.protocol === "https:" || (local && url.protocol === "http:"))) {
    throw new Error("Use an HTTPS engine URL or an HTTP loopback address for a local connection or tunnel.");
  }
  return url;
}
