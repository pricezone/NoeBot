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
import { appConfig } from "@/lib/generated/application-config";
import { WelcomeStep } from "@/routes/_authed/onboarding";

/**
 * The welcome screen: the product's name, and under it the mascot itself — Noë Bot's own face on
 * the brand rose, announced by the product's name, still.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

test("the mascot avatar sits under the welcome heading", async () => {
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: ["/"] }),
    routeTree: createRootRoute({ component: () => <WelcomeStep /> }),
  });
  const view = render(
    <QueryClientProvider client={new QueryClient()}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  const heading = await view.findByRole("heading", {
    name: `Welcome to ${appConfig.brand.productName}`,
  });
  const avatar = await view.findByRole("img", {
    name: appConfig.brand.productName,
  });
  // The mascot's own eyes, on the brand rose, below the heading.
  expect(avatar.querySelector('svg[data-face="body"]')).not.toBeNull();
  expect((avatar as HTMLElement).style.backgroundColor).not.toBe("");
  expect(
    heading.compareDocumentPosition(avatar) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
});
