import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppVariables } from "../auth/guards";
import type { UsageConfig } from "../config";

/**
 * What the platform answers when asked how much this deployment has spent.
 *
 * Checked rather than trusted. The platform is ours, but the endpoint is reached over the network
 * with a bearer that lives on a machine somebody else administers, and a shape that drifts upstream
 * would otherwise reach the account menu as `undefined credits`. A body that does not match is an
 * upstream failure, and is handled as one.
 */
const usageWindow = z.object({
  credits: z.number(),
  requests: z.number(),
});

export const usageSchema = z.object({
  period: z.object({ from: z.string(), to: z.string() }),
  week: usageWindow,
  month: usageWindow,
  balance: z.number(),
});

export type Usage = z.infer<typeof usageSchema>;

/** How long one answer is served before the platform is asked again. */
export const USAGE_CACHE_TTL_MS = 60_000;
/** How long the platform is given to answer before the cached figure, or a 503, is served instead. */
export const USAGE_TIMEOUT_MS = 10_000;

/**
 * `GET /api/usage`: the credits this deployment has spent, read from the platform that meters it.
 *
 * A proxy, not a store. The platform already holds the ledger, and the browser must not hold the
 * bearer that reads it, so the server reads on the person's behalf and answers with the figures and
 * nothing else — the token is never projected and never logged.
 *
 * ONE ANSWER PER MINUTE, PER PROCESS. The account menu asks on every open and the Settings tab asks
 * on mount, and the ledger moves per Bot turn, not per second. The last good answer is kept and
 * served for sixty seconds, and concurrent readers share one upstream call rather than each making
 * their own. When the platform cannot be reached the last good answer is served even past its
 * sixty seconds, because a stale figure beats an empty row; only a process that has never had an
 * answer tells the person the meter is unavailable.
 */
export function createUsageRoutes(
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  usage: UsageConfig,
  options: { fetchImpl?: typeof fetch; now?: () => number } = {},
) {
  const app = new Hono<{ Variables: AppVariables }>();
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;

  let cached: { usage: Usage; at: number } | undefined;
  let inflight: Promise<Usage> | undefined;

  async function readUpstream(): Promise<Usage> {
    const response = await doFetch(usage.url, {
      headers: {
        authorization: `Bearer ${usage.token}`,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(USAGE_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`The usage endpoint answered ${response.status}.`);
    }
    const parsed = usageSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new Error("The usage endpoint answered with an unexpected shape.");
    }
    return parsed.data;
  }

  /** The cached answer while it is fresh, else a shared upstream read, else the stale answer. */
  async function read(): Promise<Usage | undefined> {
    if (cached && now() - cached.at < USAGE_CACHE_TTL_MS) return cached.usage;
    if (!inflight) {
      inflight = readUpstream().finally(() => {
        inflight = undefined;
      });
    }
    try {
      const fresh = await inflight;
      cached = { usage: fresh, at: now() };
      return fresh;
    } catch {
      return cached?.usage;
    }
  }

  app.use("*", requireUser);
  app.get("/", async (context) => {
    // The browser's cache must not outlive the server's: the query layer decides when to re-ask.
    context.header("Cache-Control", "no-store");
    const answer = await read();
    if (!answer) {
      return context.json(
        { error: "Usage is not available right now. Please retry shortly." },
        503,
      );
    }
    return context.json({ usage: answer });
  });
  return app;
}
