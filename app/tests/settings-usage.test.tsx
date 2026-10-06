import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { UsageSection } from "@/components/settings/usage-section";
import {
  type DeploymentCapabilities,
  deploymentKeys,
} from "@/lib/deployment/queries";

/**
 * Settings › Usage & Billing. On a metered deployment the three cards come from `/api/usage`; on
 * one that brings its own key nothing is fetched and the page says the model is billed elsewhere.
 * "Manage billing" opens the platform's billing page in a new tab whenever the server named one,
 * on either kind of deployment.
 */

const originalFetch = globalThis.fetch;
const clients: QueryClient[] = [];
let requests: string[];

const USAGE = {
  period: { from: "2026-09-06T00:00:00Z", to: "2026-10-06T00:00:00Z" },
  week: { credits: 1234.4, requests: 56 },
  month: { credits: 12480, requests: 1 },
  balance: 98765,
};

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
beforeEach(() => {
  requests = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const path = String(input);
      requests.push(path);
      if (path === "/api/usage") return Response.json({ usage: USAGE });
      return Response.json({ error: `Unexpected ${path}` }, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.length = 0;
  globalThis.fetch = originalFetch;
});
afterAll(() => GlobalRegistrator.unregister());

function draw(capabilities: Partial<DeploymentCapabilities>) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  clients.push(client);
  client.setQueryData(deploymentKeys.capabilities(), {
    generativeUi: false,
    selfHostBanner: false,
    ...capabilities,
  });
  return render(
    <QueryClientProvider client={client}>
      <UsageSection />
    </QueryClientProvider>,
  );
}

test("a metered deployment shows the week, the month and the balance", async () => {
  const view = draw({ usage: true, billingUrl: "https://billing.example/" });
  expect(await view.findByText("This week")).toBeTruthy();
  expect(view.getByText("1,234")).toBeTruthy();
  expect(view.getByText("credits · 56 requests")).toBeTruthy();
  expect(view.getByText("This month")).toBeTruthy();
  expect(view.getByText("12,480")).toBeTruthy();
  expect(view.getByText("credits · 1 request")).toBeTruthy();
  expect(view.getByText("Balance")).toBeTruthy();
  expect(view.getByText("98,765")).toBeTruthy();
  expect(requests).toEqual(["/api/usage"]);

  const link = view.getByRole("button", { name: "Manage billing" });
  expect(link.getAttribute("href")).toBe("https://billing.example/");
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toBe("noreferrer");
});

test("a deployment on its own key says so and asks the platform nothing", async () => {
  const view = draw({ usage: false, billingUrl: "https://billing.example/" });
  expect(await view.findByText("Billed by your own provider")).toBeTruthy();
  expect(view.queryByText("This week")).toBeNull();
  expect(requests).toEqual([]);
  expect(view.getByRole("button", { name: "Manage billing" })).toBeTruthy();
});

test("without a billing page there is nothing to open", async () => {
  const view = draw({ usage: false });
  await view.findByText("Billed by your own provider");
  expect(view.queryByRole("button", { name: "Manage billing" })).toBeNull();
  expect(
    view.getByText("This deployment has no billing page to send you to."),
  ).toBeTruthy();
});
