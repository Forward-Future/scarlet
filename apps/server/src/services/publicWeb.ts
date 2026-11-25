import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { badRequest } from "../errors.js";

/** The machine itself, its local network and link-local addresses. */
const PRIVATE = new BlockList();
for (const [net, bits] of [["127.0.0.0", 8], ["10.0.0.0", 8], ["0.0.0.0", 8], ["172.16.0.0", 12], ["192.168.0.0", 16], ["169.254.0.0", 16], ["100.64.0.0", 10]] as const) PRIVATE.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::1", 128], ["::", 128], ["fe80::", 10], ["fc00::", 7]] as const) PRIVATE.addSubnet(net, bits, "ipv6");

/**
 * Whether an address is the machine itself, its local network or a link-local one, as text or as a resolved IP. An
 * IPv4 address written as IPv6 is read as the IPv4 one, in either spelling: a URL turns `::ffff:127.0.0.1` into
 * `::ffff:7f00:1`.
 */
function privateAddress(ip: string): boolean {
  return PRIVATE.check(ip, isIP(ip) === 6 ? "ipv6" : "ipv4");
}

/** The address as Chrome should open it: http or https, on a host that resolves only to public addresses. */
export async function publicWebAddress(raw: string): Promise<string> {
  let url: URL;
  try { url = new URL(raw); } catch { throw badRequest("bad_url", "Give the page's full web address, starting with https://."); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw badRequest("bad_url", "Only pages on the web (http or https) can be captured.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) throw badRequest("bad_url", "Only public pages on the web can be captured.");
  const addresses = isIP(host) ? [host] : await lookup(host, { all: true }).then(all => all.map(a => a.address), () => {
    throw badRequest("bad_url", `${host} doesn't resolve to an address.`);
  });
  if (addresses.some(privateAddress)) throw badRequest("bad_url", "Only public pages on the web can be captured.");
  return url.href;
}
