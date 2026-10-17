import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render } from "@testing-library/react";
import { authKeys, type SignInOptions } from "@/lib/auth/queries";
import { returnPathFromLocation, safeReturnPath } from "@/lib/auth/return-path";
import { Route as AuthedRoute } from "@/routes/_authed";
import { Route as SignRoute } from "@/routes/sign";

/**
 * A link into the app survives signing in: `_authed` sends somebody who is not signed in to
 * `/sign?redirect=<where they were going>`, `/sign` keeps only an in-app path, a signed-in visit
 * goes straight there, and the platform button goes through `/api/noebot/open?to=<it>`.
 */

const originalFetch = globalThis.fetch;
beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  // Nothing here needs the network (`_authed` prefetches the capabilities); it is told no.
  globalThis.fetch = Object.assign(
    async () => new Response(null, { status: 404 }),
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(cleanup);
afterAll(() => {
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

test("only an in-app path is a place to come back to", () => {
  expect(safeReturnPath("/marketplace?tab=apps&plugin=55647425")).toBe(
    "/marketplace?tab=apps&plugin=55647425",
  );
  expect(safeReturnPath("/channel/abc#m-1")).toBe("/channel/abc#m-1");
  for (const hostile of [
    "https://evil.example/",
    "//evil.example",
    "/\\evil.example",
    "javascript:alert(1)",
    "/sign",
    "/sign?redirect=/x",
    "/",
    "/a\nb",
    42,
    undefined,
  ]) {
    expect(safeReturnPath(hostile)).toBeUndefined();
  }
});

test("reads the redirect off the address the browser is on", () => {
  window.history.replaceState(
    null,
    "",
    `/sign?redirect=${encodeURIComponent("/marketplace?tab=agents&template=x")}`,
  );
  expect(returnPathFromLocation()).toBe("/marketplace?tab=agents&template=x");
  window.history.replaceState(null, "", "/sign?redirect=https://evil.example");
  expect(returnPathFromLocation()).toBeUndefined();
  window.history.replaceState(null, "", "/");
});

function contextWith(user: unknown) {
  const client = new QueryClient();
  client.setQueryData(authKeys.currentUser(), user);
  return { queryClient: client };
}

type BeforeLoad = (input: unknown) => Promise<unknown>;

async function thrownBy(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (thrown) {
    return (thrown as { options: Record<string, unknown> }).options;
  }
  throw new Error("expected a redirect");
}

test("somebody not signed in is sent to sign in with the address they asked for", async () => {
  const beforeLoad = AuthedRoute.options.beforeLoad as unknown as BeforeLoad;
  expect(
    await thrownBy(() =>
      beforeLoad({
        context: contextWith(null),
        location: {
          pathname: "/marketplace",
          href: "/marketplace?tab=apps&plugin=55647425",
        },
      }),
    ),
  ).toMatchObject({
    to: "/sign",
    search: { redirect: "/marketplace?tab=apps&plugin=55647425" },
  });
  // Home needs nothing carried.
  expect(
    await thrownBy(() =>
      beforeLoad({
        context: contextWith(null),
        location: { pathname: "/", href: "/" },
      }),
    ),
  ).toMatchObject({ to: "/sign", search: {} });
});

test("the sign-in screen keeps only an in-app redirect, and a signed-in visit goes straight there", async () => {
  const validate = SignRoute.options.validateSearch as (
    search: Record<string, unknown>,
  ) => { redirect?: string };
  expect(validate({ redirect: "/marketplace?tab=apps" })).toEqual({
    redirect: "/marketplace?tab=apps",
  });
  expect(validate({ redirect: "https://evil.example" })).toEqual({});

  const beforeLoad = SignRoute.options.beforeLoad as unknown as BeforeLoad;
  const signedIn = { id: "u", email: "a@b.c", role: "admin", onboarding: null };
  expect(
    await thrownBy(() =>
      beforeLoad({
        context: contextWith(signedIn),
        search: { redirect: "/marketplace?tab=apps" },
      }),
    ),
  ).toMatchObject({ href: "/marketplace?tab=apps" });
  expect(
    await thrownBy(() =>
      beforeLoad({ context: contextWith(signedIn), search: {} }),
    ),
  ).toMatchObject({ to: "/" });
});

test("the platform button carries the page through the platform's open route", async () => {
  const client = new QueryClient();
  client.setQueryData(authKeys.currentUser(), null);
  const options: SignInOptions = {
    providers: [],
    sso: false,
    ssoRequired: false,
    handoff: {
      providerName: "HyperNoesis",
      returnUrl: "https://www.hypernoesis.ai/noebot",
    },
  };
  client.setQueryData(authKeys.providers(), options);
  const root = createRootRoute();
  const sign = (
    SignRoute as unknown as { update: (options: unknown) => typeof SignRoute }
  ).update({ id: "/sign", path: "/sign", getParentRoute: () => root });
  const draw = (href: string) =>
    render(
      <QueryClientProvider client={client}>
        <RouterProvider
          router={
            createRouter({
              routeTree: root.addChildren([sign]),
              context: { queryClient: client },
              history: createMemoryHistory({ initialEntries: [href] }),
            }) as never
          }
        />
      </QueryClientProvider>,
    );

  const view = draw(
    `/sign?redirect=${encodeURIComponent("/marketplace?tab=apps&app=slack")}`,
  );
  const button = await view.findByRole("button", {
    name: "Continue with HyperNoesis",
  });
  expect(button.getAttribute("href")).toBe(
    `https://www.hypernoesis.ai/api/noebot/open?to=${encodeURIComponent("/marketplace?tab=apps&app=slack")}`,
  );
  cleanup();

  const plain = draw("/sign");
  expect(
    (
      await plain.findByRole("button", { name: "Continue with HyperNoesis" })
    ).getAttribute("href"),
  ).toBe("https://www.hypernoesis.ai/noebot");
});
