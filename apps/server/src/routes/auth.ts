import { Hono } from "hono";
import type { AppEnv } from "../auth.js";

export function authRoutes() {
  const r = new Hono<AppEnv>();
  /** Lets a client check its token; returns the local user. */
  r.get("/auth/me", (c) => c.json({ user: c.var.user }));
  return r;
}
