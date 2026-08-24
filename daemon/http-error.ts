// A plain Error carrying an HTTP status code, so domain layers (registry/ExtConn)
// can throw and the HTTP layer translates code→response in one place.
//
// Errors also carry a machine-readable `code` and a `retriable` hint. Both are
// ADDITIVE: the response keeps `error` as a human-readable string, because
// callers written against earlier versions read exactly that field. The point of
// `code` is to stop callers from pattern-matching on message text — which they
// otherwise will, and which then breaks the moment a message is reworded.

/** Defaults per HTTP status, overridable per throw site. */
const BY_STATUS: Record<number, { code: string; retriable: boolean }> = {
  400: { code: "BAD_REQUEST", retriable: false },
  404: { code: "NOT_FOUND", retriable: false },
  409: { code: "CONFLICT", retriable: false },
  500: { code: "INTERNAL", retriable: false },
  503: { code: "UNAVAILABLE", retriable: true },
  504: { code: "TIMEOUT", retriable: true },
};

/** An Error that also knows its HTTP status and machine-readable failure class. */
export interface HttpError extends Error {
  httpCode: number;
  code: string;
  retriable: boolean;
}

/**
 * @param httpCode HTTP status to translate this into at the edge
 * @param message  human-readable, and only that — callers branch on `code`, not this
 * @param opts     `code`/`retriable` override the per-status defaults
 */
export function httpError(
  httpCode: number,
  message: string,
  opts: { code?: string; retriable?: boolean } = {},
): HttpError {
  const fallback = BY_STATUS[httpCode] ?? { code: "INTERNAL", retriable: false };
  const e = new Error(message) as HttpError;
  e.httpCode = httpCode;
  e.code = opts.code ?? fallback.code;
  e.retriable = opts.retriable ?? fallback.retriable;
  return e;
}

/** The full set, so callers can exhaustively switch. Keep in sync with SPEC.md. */
export const ERROR_CODES = [
  "NO_BROWSER",
  "UNKNOWN_BROWSER",
  "AMBIGUOUS_BROWSER",
  "EXT_NOT_READY",
  "EXT_DISCONNECTED",
  "TAB_NOT_ATTACHED",
  "TAB_DETACHED",
  "TIMEOUT",
  "BAD_REQUEST",
  "NOT_FOUND",
  "CONFLICT",
  "UNAVAILABLE",
  "INTERNAL",
  "DEBUGGER_ERROR",
] as const;
