import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { deploymentCapabilitiesQueryOptions } from "../src/lib/deployment/queries";
import {
  formatCredits,
  parseUsage,
  type Usage,
  usageKeys,
  usageQueryOptions,
} from "../src/lib/usage/queries";

afterEach(() => {
  mock.restore();
});

function mockFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
  spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(handler, { preconnect: globalThis.fetch.preconnect }),
  );
}

const usage: Usage = {
  period: { from: "2026-09-06T00:00:00.000Z", to: "2026-10-06T00:00:00.000Z" },
  week: { credits: 1240, requests: 31 },
  month: { credits: 4875, requests: 118 },
  balance: 10125,
};

test("uses a stable key for the usage summary", () => {
  expect(usageKeys.summary()).toEqual(["usage", "summary"]);
  // Spread before comparing: `queryOptions` brands its key with TanStack's `DataTag` phantom
  // symbols, which exist only in the type system and no literal can satisfy.
  expect([...usageQueryOptions().queryKey]).toEqual(["usage", "summary"]);
  expect(usageQueryOptions().staleTime).toBe(60_000);
  expect(usageQueryOptions().retry).toBe(1);
});

test("accepts the platform's shape and nothing looser", () => {
  expect(parseUsage(usage)).toEqual(usage);
  // Extra fields are dropped rather than passed through.
  expect(parseUsage({ ...usage, token: "secret" })).toEqual(usage);

  expect(parseUsage(null)).toBeNull();
  expect(parseUsage("1240")).toBeNull();
  expect(parseUsage({})).toBeNull();
  expect(parseUsage({ ...usage, period: { from: "x" } })).toBeNull();
  expect(
    parseUsage({ ...usage, week: { credits: "1240", requests: 31 } }),
  ).toBeNull();
  expect(parseUsage({ ...usage, month: undefined })).toBeNull();
  expect(parseUsage({ ...usage, balance: Number.NaN })).toBeNull();
  expect(parseUsage({ ...usage, balance: "10125" })).toBeNull();
});

test("formats credits as whole numbers a person can read", () => {
  expect(formatCredits(0)).toBe("0");
  expect(formatCredits(7)).toBe("7");
  expect(formatCredits(1240)).toBe("1,240");
  expect(formatCredits(1_234_567)).toBe("1,234,567");
  expect(formatCredits(12.6)).toBe("13");
  expect(formatCredits(-250)).toBe("-250");
  expect(formatCredits(Number.NaN)).toBe("0");
  expect(formatCredits(Number.POSITIVE_INFINITY)).toBe("0");
});

test("reads the usage envelope and refuses an answer that is not one", async () => {
  mockFetch(async (input) => {
    expect(String(input)).toBe("/api/usage");
    return Response.json({ usage });
  });
  await expect(usageQueryOptions().queryFn?.({} as never)).resolves.toEqual(
    usage,
  );

  mockFetch(async () => Response.json({ usage: { week: {} } }));
  await expect(usageQueryOptions().queryFn?.({} as never)).rejects.toThrow(
    "Could not load usage",
  );

  mockFetch(async () =>
    Response.json(
      { error: "Usage is not available right now. Please retry shortly." },
      { status: 503 },
    ),
  );
  await expect(usageQueryOptions().queryFn?.({} as never)).rejects.toThrow(
    "Usage is not available right now. Please retry shortly.",
  );
});

test("reads the usage capability and the billing link off the deployment", async () => {
  mockFetch(async () =>
    Response.json({
      generativeUi: true,
      selfHostBanner: false,
      usage: true,
      billingUrl: "https://www.hypernoesis.ai/dashboard/settings/billing",
    }),
  );
  await expect(
    deploymentCapabilitiesQueryOptions().queryFn?.({} as never),
  ).resolves.toEqual({
    generativeUi: true,
    selfHostBanner: false,
    transcription: false,
    voice: false,
    usage: true,
    billingUrl: "https://www.hypernoesis.ai/dashboard/settings/billing",
  });

  // Null from a server with no billing page, and no field from an older server, both read as
  // "nothing to link to"; the capability fails closed.
  mockFetch(async () =>
    Response.json({
      generativeUi: true,
      selfHostBanner: true,
      billingUrl: null,
    }),
  );
  const older = await deploymentCapabilitiesQueryOptions().queryFn?.(
    {} as never,
  );
  expect(older?.usage).toBe(false);
  expect(older).not.toHaveProperty("billingUrl");
});
