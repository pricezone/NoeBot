import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/** Credits and requests over one window of time. */
export type UsageWindow = {
  credits: number;
  requests: number;
};

/**
 * How much this deployment has spent, as the platform that meters it answers.
 *
 * `week` is the rolling seven days ending now and `month` the rolling thirty, both inside `period`;
 * `balance` is what the subscriber has left to spend. There is no included allowance to measure
 * against, which is why the meter shows figures and not a percentage.
 */
export type Usage = {
  period: { from: string; to: string };
  week: UsageWindow;
  month: UsageWindow;
  balance: number;
};

export const usageKeys = {
  all: ["usage"] as const,
  summary: () => ["usage", "summary"] as const,
};

function isWindow(value: unknown): value is UsageWindow {
  if (!value || typeof value !== "object") return false;
  const window = value as Record<string, unknown>;
  return (
    typeof window.credits === "number" &&
    Number.isFinite(window.credits) &&
    typeof window.requests === "number" &&
    Number.isFinite(window.requests)
  );
}

/**
 * The server's answer, or null when it is not one.
 *
 * Checked field by field rather than cast, because the figure lands in a menu row as "N credits" and
 * a missing number would be read as "undefined credits". The server already validated the platform's
 * shape; this guards the one hop left, from the server to here, and keeps the type honest.
 */
export function parseUsage(body: unknown): Usage | null {
  if (!body || typeof body !== "object") return null;
  const usage = body as Record<string, unknown>;
  const period = usage.period as Record<string, unknown> | undefined;
  if (
    !period ||
    typeof period !== "object" ||
    typeof period.from !== "string" ||
    typeof period.to !== "string"
  ) {
    return null;
  }
  if (!isWindow(usage.week) || !isWindow(usage.month)) return null;
  if (typeof usage.balance !== "number" || !Number.isFinite(usage.balance)) {
    return null;
  }
  return {
    period: { from: period.from, to: period.to },
    week: { credits: usage.week.credits, requests: usage.week.requests },
    month: { credits: usage.month.credits, requests: usage.month.requests },
    balance: usage.balance,
  };
}

const credits = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/**
 * A credit figure as a person reads it: `12,480`, never `12480.000000001`.
 *
 * Whole numbers with thousands separators. Credits are integers on the platform's ledger, so a
 * fraction here is rounding noise from a sum, not information. Anything that is not a finite number
 * reads as zero rather than `NaN`, because this lands in a menu row with no room to explain.
 */
export function formatCredits(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return credits.format(Math.round(value));
}

/**
 * How much this deployment has spent.
 *
 * A minute of staleness is deliberate and matches the server, which keeps its own answer for sixty
 * seconds: the figure moves per Bot turn, and the account menu opening twice in a minute should not
 * ask the platform twice. One retry, because the server already serves its last good answer when
 * the platform is slow, so a second failure is a real one and the row should say so.
 */
export function usageQueryOptions() {
  return queryOptions({
    queryKey: usageKeys.summary(),
    staleTime: 60_000,
    retry: 1,
    queryFn: async (): Promise<Usage> => {
      const body = await client<unknown>("/api/usage", "usage", {
        fallback: "Could not load usage",
      });
      const usage = parseUsage(body);
      if (!usage) throw new Error("Could not load usage");
      return usage;
    },
  });
}
