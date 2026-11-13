/** HTTP error carrying a machine-readable code; serialized as `{ error: { code, message, details } }`. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const notFound = (what: string) => new HttpError(404, "not_found", `${what} not found`);
export const forbidden = (message = "forbidden") => new HttpError(403, "forbidden", message);
export const unauthorized = (message = "unauthorized") => new HttpError(401, "unauthorized", message);
export const badRequest = (code: string, message: string, details?: unknown) =>
  new HttpError(400, code, message, details);
export const conflict = (code: string, message: string, details?: unknown) =>
  new HttpError(409, code, message, details);
