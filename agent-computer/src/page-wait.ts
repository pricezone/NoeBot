/**
 * Waiting on a page for something to appear, instead of sleeping.
 *
 * Content that arrives after a delay is ordinary: search results, a "Hello World!" a script reveals,
 * a confirmation after a submit. A Bot with no way to wait for it slept in the shell, ten seconds at
 * a time, or read the page again and again, a model round trip each. `computer_read` with `waitFor`
 * polls the page's own text and answers the moment the words are there, or says they never came.
 */

/** The longest one read may wait, so a turn never stalls on a page that will not change. */
export const MAX_WAIT_MS = 20_000;
export const DEFAULT_WAIT_MS = 15_000;
const POLL_MS = 250;

export type ReadWait = { text: string; timeoutMs: number };

/** `?waitFor=…&timeoutMs=…` from a read request, or nothing when it asks to wait for nothing. */
export function readWait(params: URLSearchParams): ReadWait | undefined {
  const text = (params.get("waitFor") ?? "").trim().slice(0, 200);
  if (!text) return undefined;
  const asked = Number(params.get("timeoutMs"));
  const timeoutMs =
    Number.isFinite(asked) && asked > 0
      ? Math.min(MAX_WAIT_MS, Math.round(asked))
      : DEFAULT_WAIT_MS;
  return { text, timeoutMs };
}

/** Case- and space-insensitive, so "hello  world" finds "Hello World!". */
function contains(haystack: string, needle: string): boolean {
  const tidy = (value: string) => value.replace(/\s+/g, " ").toLowerCase();
  return tidy(haystack).includes(tidy(needle));
}

export async function waitForPageText<T extends { text: string }>(
  read: () => Promise<T>,
  wanted: ReadWait,
  {
    now = Date.now,
    sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms)),
  }: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ extract: T; found: boolean; ms: number }> {
  const started = now();
  for (;;) {
    const extract = await read();
    const ms = now() - started;
    if (contains(extract.text, wanted.text))
      return { extract, found: true, ms };
    if (ms >= wanted.timeoutMs) return { extract, found: false, ms };
    await sleep(Math.min(POLL_MS, wanted.timeoutMs - ms));
  }
}
