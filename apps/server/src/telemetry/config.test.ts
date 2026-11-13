import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { SCARLET_VERSION, telemetryConfig } from "./config.js";

it("is on by default, with no key and the US host", () => {
  expect(telemetryConfig({})).toEqual({
    enabled: true,
    posthogKey: undefined,
    posthogHost: "https://us.i.posthog.com",
    flushBatchSize: 20,
    maxBufferedEvents: 1000,
  });
});

it.each(["false", "0", "no", "off", "FALSE", " Off "])("is off when SCARLET_TELEMETRY_ENABLED is %j", value => {
  expect(telemetryConfig({ SCARLET_TELEMETRY_ENABLED: value }).enabled).toBe(false);
});

it.each(["true", "1", "", "yes", "on"])("is on when SCARLET_TELEMETRY_ENABLED is %j", value => {
  expect(telemetryConfig({ SCARLET_TELEMETRY_ENABLED: value }).enabled).toBe(true);
});

it("takes the key from the environment before the built-in one", () => {
  expect(telemetryConfig({ SCARLET_POSTHOG_KEY: " phc_env " }, "phc_default").posthogKey).toBe("phc_env");
  expect(telemetryConfig({ SCARLET_POSTHOG_KEY: "  " }, "phc_default").posthogKey).toBe("phc_default");
  expect(telemetryConfig({}, " phc_default ").posthogKey).toBe("phc_default");
  expect(telemetryConfig({}, "").posthogKey).toBeUndefined();
});

it("drops trailing slashes from the host", () => {
  expect(telemetryConfig({ SCARLET_POSTHOG_HOST: " https://eu.i.posthog.com// " }).posthogHost).toBe("https://eu.i.posthog.com");
  expect(telemetryConfig({ SCARLET_POSTHOG_HOST: " " }).posthogHost).toBe("https://us.i.posthog.com");
});

it.each(["0", "-1", "abc", "1.5", ""])("keeps the default sizes when given %j", value => {
  const config = telemetryConfig({ SCARLET_TELEMETRY_FLUSH_BATCH_SIZE: value, SCARLET_TELEMETRY_MAX_BUFFERED_EVENTS: value });
  expect(config.flushBatchSize).toBe(20);
  expect(config.maxBufferedEvents).toBe(1000);
});

it("reads the sizes", () => {
  const config = telemetryConfig({ SCARLET_TELEMETRY_FLUSH_BATCH_SIZE: " 7 ", SCARLET_TELEMETRY_MAX_BUFFERED_EVENTS: "50" });
  expect(config.flushBatchSize).toBe(7);
  expect(config.maxBufferedEvents).toBe(50);
});

it("reports the version in package.json", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  expect(SCARLET_VERSION).toBe(manifest.version);
});
