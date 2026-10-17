import { expect, test } from "bun:test";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { shareLinkFor } from "@/lib/share-link";

/**
 * A Share link opens on any Noë Bot instance: through the platform when the deployment has one
 * (`https://<platform>/api/noebot/share?to=<in-app path, encoded>`), else this deployment's own
 * address.
 */

test("goes through the platform, carrying the in-app path and its search", () => {
  expect(
    shareLinkFor(
      "/marketplace?tab=apps&plugin=55647425",
      "https://www.hypernoesis.ai",
      "https://bot.example",
    ),
  ).toBe(
    "https://www.hypernoesis.ai/api/noebot/share?to=%2Fmarketplace%3Ftab%3Dapps%26plugin%3D55647425",
  );
  expect(
    shareLinkFor(
      "/marketplace?tab=agents&template=a b",
      "https://p.example/",
      "x",
    ),
  ).toBe(
    `https://p.example/api/noebot/share?to=${encodeURIComponent("/marketplace?tab=agents&template=a b")}`,
  );
});

test("without a platform, is this deployment's own address", () => {
  expect(
    shareLinkFor(
      "/marketplace?tab=apps&app=slack",
      undefined,
      "https://bot.example",
    ),
  ).toBe("https://bot.example/marketplace?tab=apps&app=slack");
});

test("the platform is the server's share base, else the origin of its sign-in handoff's return address", async () => {
  const original = globalThis.fetch;
  const capabilities = async (body: Record<string, unknown>) => {
    globalThis.fetch = Object.assign(async () => Response.json(body), {
      preconnect: original.preconnect,
    });
    try {
      return await deploymentCapabilitiesQueryOptions().queryFn?.({} as never);
    } finally {
      globalThis.fetch = original;
    }
  };
  expect(
    (
      await capabilities({
        signInHandoff: {
          providerName: "HyperNoesis",
          returnUrl: "https://www.hypernoesis.ai/noebot",
        },
      })
    )?.shareBase,
  ).toBe("https://www.hypernoesis.ai");
  expect(
    (
      await capabilities({
        shareBaseUrl: "https://share.example",
        signInHandoff: {
          providerName: "HyperNoesis",
          returnUrl: "https://www.hypernoesis.ai/noebot",
        },
      })
    )?.shareBase,
  ).toBe("https://share.example");
  expect(
    await capabilities({ signInHandoff: { returnUrl: "javascript:alert(1)" } }),
  ).not.toHaveProperty("shareBase");
  expect(await capabilities({ signInHandoff: null })).not.toHaveProperty(
    "shareBase",
  );
});
