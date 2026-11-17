/**
 * Render an error together with its cause chain.
 *
 * Node's `fetch` wraps every transport failure in `TypeError: fetch failed`,
 * which says nothing about WHY. The real reason lives on `err.cause`
 * (`UND_ERR_BODY_TIMEOUT`, `ECONNREFUSED`, `CERT_HAS_EXPIRED`, ...), so a
 * report that only prints `err.message` sends whoever reads it hunting.
 */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);

  const parts: string[] = [`${err.name}: ${err.message}`];
  let cause: unknown = (err as { cause?: unknown }).cause;
  let depth = 0;

  while (cause !== undefined && cause !== null && depth < 4) {
    if (cause instanceof Error) {
      const code = (cause as { code?: string }).code;
      parts.push(`${cause.name}: ${cause.message}${code ? ` (${code})` : ''}`);
      cause = (cause as { cause?: unknown }).cause;
    } else {
      parts.push(String(cause));
      break;
    }
    depth += 1;
  }

  return parts.join(' <- ');
}
