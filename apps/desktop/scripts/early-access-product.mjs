// Apply the 0.1.3 Early Access identity to the disposable build checkout.
// Tauri derives its per-user NSIS installation and upgrade keys from the publisher and product name.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const earlyAccessName = "Scarlet Early Access";
export const earlyAccessId = "com.forwardfuture.scarlet.earlyaccess";

export function applyEarlyAccessProduct(config) {
  const main = config.app.windows.find(window => window.label === "main");
  if (!main || config.bundle.publisher !== "Forward Future" || config.bundle.windows.nsis.installMode !== "currentUser") {
    throw new Error("The Early Access upgrade requires a main window and the original Windows publisher and per-user install mode.");
  }
  config.productName = main.title = earlyAccessName;
  config.identifier = earlyAccessId;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = new URL("../src-tauri/tauri.conf.json", import.meta.url);
  const config = JSON.parse(readFileSync(path, "utf8"));
  applyEarlyAccessProduct(config);
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n");
}
