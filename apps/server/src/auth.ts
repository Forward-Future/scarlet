import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { closeSync, constants, existsSync, fchmodSync, fstatSync, linkSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";
import type { User } from "@scarlet/shared";
import type { Ctx } from "./context.js";
import { unauthorized } from "./errors.js";
import { restrictWindowsAccess } from "./privateStorage.js";

/**
 * Scarlet is single-user: there is one local user, created on first start, and
 * no login. Requests still carry a bearer token so that nothing else on the
 * machine or network can drive the server; the token is handed to the desktop
 * app through its engine startup handshake.
 */
export type AppEnv = { Variables: { user: User } };

// -- the local user ------------------------------------------------------------

/** The local user, created on first use. Databases from multi-user versions keep their first owner. */
export function localUser(ctx: Ctx): User {
  const existing = ctx.repos.users.primary();
  if (existing) return existing;
  return ctx.repos.users.create({ name: process.env.USERNAME ?? process.env.USER ?? "You" });
}

// -- tokens -------------------------------------------------------------------

const workspaceTokens = new WeakMap<Ctx, string>();
const desktopSessions = new WeakMap<Ctx, string>();

function protectToken(file: string, fd: number) {
  const stat = fstatSync(fd);
  if (!stat.isFile()) throw new Error("Workspace token must be a regular file");
  if (process.platform !== "win32") {
    if (stat.mode & 0o077) fchmodSync(fd, 0o600);
    return;
  }
  restrictWindowsAccess(file, "File");
}

/** One private capability per workspace. Old account sessions and agent tokens do not grant access. */
export function accessToken(ctx: Ctx): string {
  const cached = workspaceTokens.get(ctx);
  if (cached) return cached;
  const file = ctx.paths.accessToken;
  if (!existsSync(file)) {
    // Publish a fully written file even if two engines open this workspace together.
    const tmp = file + "." + randomUUID();
    const fd = openSync(tmp, "wx", 0o600);
    try {
      protectToken(tmp, fd);
      writeFileSync(fd, "sct_" + randomBytes(32).toString("hex") + "\n");
      linkSync(tmp, file);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    } finally {
      closeSync(fd);
      unlinkSync(tmp);
    }
  }
  if (!lstatSync(file).isFile()) throw new Error("Invalid workspace access-token file");
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let token: string;
  try {
    protectToken(file, fd);
    token = readFileSync(fd, "utf8").trim();
  } finally {
    closeSync(fd);
  }
  if (!/^sct_[a-f0-9]{64}$/.test(token)) throw new Error("Invalid workspace access-token file");
  workspaceTokens.set(ctx, token);
  return token;
}

/** Pair the loopback port with a fresh credential valid only in this listening desktop engine. */
export function publishDesktopSession(ctx: Ctx, port: number) {
  const token = "sct_" + randomBytes(32).toString("hex");
  const file = join(ctx.paths.root, "desktop-session.json");
  const tmp = file + "." + randomUUID();
  const fd = openSync(tmp, "wx", 0o600);
  try {
    try {
      protectToken(tmp, fd);
      writeFileSync(fd, JSON.stringify({ port, token }) + "\n");
    } finally { closeSync(fd); }
    renameSync(tmp, file);
    desktopSessions.set(ctx, token);
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
  }
}

export function resolveToken(ctx: Ctx, token: string): User | null {
  const candidate = Buffer.from(token);
  for (const value of [accessToken(ctx), desktopSessions.get(ctx)]) {
    if (!value) continue;
    const expected = Buffer.from(value);
    if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) return localUser(ctx);
  }
  return null;
}

/** The token in an `Authorization: Bearer …` header, or null when the header has none. */
export function bearerToken(header: string | undefined): string | null {
  return header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : null;
}

export function tokenFromRequest(req: { header(name: string): string | undefined; query(name: string): string | undefined }) {
  return bearerToken(req.header("authorization")) ?? (req.query("token") || undefined);
}

/** Hono middleware: requires a valid bearer token (or `?token=`), sets `c.var.user`. */
export function authMiddleware(ctx: Ctx): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = tokenFromRequest(c.req);
    if (!token) throw unauthorized("missing bearer token");
    const user = resolveToken(ctx, token);
    if (!user) throw unauthorized("invalid token");
    c.set("user", user);
    await next();
  };
}
