import { createRequire } from "node:module";
import { Hono } from "hono";
import { expect, it, vi } from "vitest";
import { z } from "zod/v3";
import { z as z4 } from "zod/v4";
import type { AppEnv } from "../auth.js";
import { HttpError } from "../errors.js";
import { jsonBody } from "./util.js";

const require = createRequire(import.meta.url);

it("rejects an oversized collection before parsing any element in either schema API", async () => {
  const visited = vi.fn(() => true);
  for (const api of [z, require("zod/v3").z as typeof z]) {
    const item = api.string().refine(visited);
    for (const schema of [api.array(item).max(1), api.array(item).length(1), api.tuple([item])]) {
      expect(schema.safeParse(["one", "two"]).success).toBe(false);
      expect((await schema.safeParseAsync(["one", "two"])).success).toBe(false);
    }
    expect(api.set(item).max(1).safeParse(new Set(["one", "two"])).success).toBe(false);
  }
  const collection = z4.array(z4.string().refine(visited)).max(1);
  expect(collection.safeParse(["one", "two"]).success).toBe(false);
  expect(visited).not.toHaveBeenCalled();
  expect(collection.parse(["one"])).toEqual(["one"]);
  expect(z.array(z.string().refine(visited)).length(1).parse(["one"])).toEqual(["one"]);
  expect(visited).toHaveBeenCalledTimes(2);
});

it("bounds errors from unconstrained arrays and still reads every item of valid arrays", async () => {
  const items = Array.from({ length: 100 }, (_, i) => i);
  const array = z.array(z.number().nonnegative());
  const invalid = items.map(() => -1);
  for (const result of [array.safeParse(invalid), await array.safeParseAsync(invalid)]) {
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toHaveLength(64);
  }
  expect(array.parse(items)).toEqual(items);
  expect(await array.parseAsync(items)).toEqual(items);
});

it("counts streamed JSON bytes before parsing, including split UTF-8 and inaccurate lengths", async () => {
  const app = new Hono<AppEnv>();
  const validated = vi.fn(() => true);
  const schema = z.object({ name: z.string().optional() }).refine(validated);
  const bytes = new TextEncoder().encode(JSON.stringify({ name: "ä" }));
  app.onError((error, c) => {
    if (error instanceof HttpError) return c.text(error.code, error.status === 413 ? 413 : 400);
    throw error;
  });
  app.post("/", async c => c.json(await jsonBody(c, schema, bytes.length)));
  const send = (parts: Uint8Array[], declared?: string) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    });
    const request = new Request("http://localhost/", { method: "POST", body, duplex: "half",
      headers: declared ? { "Content-Length": declared } : undefined } as RequestInit);
    return app.request(request);
  };
  const split = bytes.indexOf(0xc3) + 1;
  const success = await send([bytes.subarray(0, split), bytes.subarray(split)]);
  expect(success.status).toBe(200);
  expect(await success.json()).toEqual({ name: "ä" });
  for (const declared of [undefined, "1", String(bytes.length + 1)]) {
    const response = await send([bytes, Uint8Array.of(32)], declared);
    expect(response.status).toBe(413);
    expect(await response.text()).toBe("json_too_large");
  }
  expect(validated).toHaveBeenCalledTimes(1);
  expect(await (await send([])).json()).toEqual({});
  expect(await (await send([Uint8Array.of(123)])).text()).toBe("bad_json");
});
