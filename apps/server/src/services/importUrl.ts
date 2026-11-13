import { lookup } from "node:dns/promises";
import { get as httpGet, type IncomingMessage } from "node:http";
import { get as httpsGet } from "node:https";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { badRequest } from "../errors.js";

function publicAddress(address: string): boolean {
  const ip = ipaddr.parse(address);
  if (ip.range() !== "unicast") return false;
  // Only globally routable IPv6 unicast. Excludes translation and tunnel addresses.
  return ip.kind() === "ipv4" || (ip.toByteArray()[0]! & 0xe0) === 0x20;
}

/** The system resolver has no signal option. An abandoned lookup must never start a connection. */
async function lookupHost(host: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const pending = lookup(host, { all: true });
  if (!signal) return pending;
  return new Promise<Awaited<typeof pending>>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

/** Resolve and pin each hop, preserving the HTTP Host header and TLS certificate checks. */
export async function downloadImport(url: URL, signal?: AbortSignal): Promise<IncomingMessage> {
  for (let hop = 0; hop <= 5; hop++) {
    signal?.throwIfAborted();
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw badRequest("invalid_url", "use a public HTTP(S) URL");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookupHost(host, signal);
    if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) {
      throw badRequest("invalid_url", "the media URL must resolve to a public address");
    }
    const peer = addresses[0]!;
    const res = await new Promise<IncomingMessage>((resolve, reject) => {
      const get = url.protocol === "https:" ? httpsGet : httpGet;
      // Supplying the lookup result to this socket also prevents DNS rebinding.
      const req = get(url, { signal, agent: false, family: peer.family,
        lookup: (_hostname, _options, cb) => cb(null, peer.address, peer.family),
      }, resolve);
      req.on("error", reject);
      req.setTimeout(30_000, () => req.destroy(new Error("media download timed out")));
    });
    if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0) && res.headers.location) {
      res.destroy();
      url = new URL(res.headers.location, url);
      continue;
    }
    if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300 || res.headers["content-type"]?.startsWith("text/html")) {
      res.destroy();
      throw badRequest("download_failed", "URL did not return a media file");
    }
    return res;
  }
  throw badRequest("download_failed", "too many redirects");
}
