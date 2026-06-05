// A plain Error carrying an HTTP status code, so domain layers (registry/ExtConn)
// can throw and the HTTP layer translates code→response in one place.

/**
 * @param {number} code  HTTP status code
 * @param {string} message
 * @returns {Error & { httpCode: number }}
 */
export function httpError(code, message) {
  const e = /** @type {Error & { httpCode: number }} */ (new Error(message));
  e.httpCode = code;
  return e;
}
