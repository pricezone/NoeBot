import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useState } from "react";
import type { ControlState } from "@/lib/computers/control";
import { ComputerControlButton } from "@/components/computer/computer-controls";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useComputerControl } from "@/lib/computers/use-control";

const originalFetch = globalThis.fetch;
beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
afterAll(() => GlobalRegistrator.unregister());

function server(initial: "bot" | "human" = "bot") {
  let state: ControlState = {
    holder: initial,
    since: "2026-09-26T00:00:00Z",
    requested: false,
    transitioning: false,
    resumeSnapshotRequired: false,
    ...(initial === "human"
      ? {
          request: {
            id: "request-1",
            status: "taken" as const,
            reason: "Please help",
            source: "manual" as const,
            createdAt: "2026-09-26T00:00:00Z",
            updatedAt: "2026-09-26T00:00:00Z",
          },
        }
      : {}),
  };
  const calls: { path: string; body: unknown }[] = [];
  let fail = false;
  let completeTake: (() => void) | undefined;
  let holdTake = false;
  globalThis.fetch = Object.assign(
    async (
      url: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1],
    ) => {
      const path = String(url);
      const body: unknown = init?.body
        ? JSON.parse(String(init.body))
        : undefined;
      calls.push({ path, body });
      if (fail && path.endsWith("/control/take"))
        return Response.json({ error: "Unavailable" }, { status: 503 });
      if (path.endsWith("/control/request"))
        state = {
          ...state,
          requested: true,
          request: {
            id: "request-1",
            status: "waiting",
            reason: "Manual control",
            source: "manual",
            createdAt: state.since,
            updatedAt: state.since,
          },
        };
      if (path.endsWith("/control/take")) {
        if (holdTake)
          await new Promise<void>((resolve) => {
            completeTake = resolve;
          });
        if (state.request)
          state = {
            ...state,
            requested: false,
            holder: "human",
            request: { ...state.request, status: "taken" },
          };
      }
      if (path.endsWith("/control/release") && state.request)
        state = {
          ...state,
          holder: "bot",
          request: { ...state.request, status: "completed" },
        };
      return Response.json(state);
    },
    { preconnect: () => undefined },
  );
  return {
    calls,
    fail: () => {
      fail = true;
    },
    recover: () => {
      fail = false;
    },
    delayTake: () => {
      holdTake = true;
    },
    finishTake: () => completeTake?.(),
    transition: () => {
      state = { ...state, transitioning: true };
    },
  };
}
/**
 * The viewer's Minimize, as far as control goes: the shared store's own release. Handing back is
 * no longer this button's job — there is no Hand back — so the tests that need control returned
 * return it the way the viewer does.
 */
function MinimizeProbe({ botId }: { botId: string }) {
  const { change } = useComputerControl(botId);
  return (
    <button type="button" onClick={() => void change?.("release")}>
      Minimize screen
    </button>
  );
}

function controls(botId = "control-test") {
  const view = render(
    <>
      <section aria-label="Chat">
        <ComputerControlButton computerId={botId} />
      </section>
      <section aria-label="Computer sidebar">
        <ComputerControlButton computerId={botId} />
      </section>
    </>,
  );
  return {
    ...view,
    chat: within(view.getByRole("region", { name: "Chat" })),
    sidebar: within(view.getByRole("region", { name: "Computer sidebar" })),
  };
}

test("chat and sidebar always show controls and update together using the exact request", async () => {
  const backend = server();
  const view = controls();
  await waitFor(() =>
    expect(
      view.chat
        .getByRole("button", { name: "Take control" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(view.chat.getByRole("button", { name: "Take control" }));
  expect(
    await view.sidebar.findByRole("button", { name: "Keep control" }),
  ).toBeTruthy();
  expect(view.chat.getByRole("button", { name: "Keep control" })).toBeTruthy();
  const minimize = render(<MinimizeProbe botId="control-test" />);
  fireEvent.click(minimize.getByRole("button", { name: "Minimize screen" }));
  expect(
    await view.chat.findByRole("button", { name: "Take control" }),
  ).toBeTruthy();
  expect(
    backend.calls
      .filter(
        (call) =>
          call.path.endsWith("/control/take") ||
          call.path.endsWith("/control/release"),
      )
      .map((call) => call.body),
  ).toEqual([{ requestId: "request-1" }, { requestId: "request-1" }]);
  expect(
    backend.calls.filter((call) => call.path.endsWith("/control/request")),
  ).toHaveLength(1);
});

test("an in-flight takeover disables both controls and prevents duplicate requests", async () => {
  const backend = server();
  backend.delayTake();
  const view = controls();
  await waitFor(() =>
    expect(
      view.chat
        .getByRole("button", { name: "Take control" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(view.chat.getByRole("button", { name: "Take control" }));
  await waitFor(() =>
    expect(
      view.sidebar
        .getByRole("button", { name: "Take control" })
        .hasAttribute("disabled"),
    ).toBe(true),
  );
  fireEvent.click(view.sidebar.getByRole("button", { name: "Take control" }));
  backend.finishTake();
  await view.chat.findByRole("button", { name: "Keep control" });
  expect(
    backend.calls.filter((call) => call.path.endsWith("/control/take")),
  ).toHaveLength(1);
});

test("a failed takeover is visible in both surfaces and can be retried", async () => {
  const backend = server();
  backend.fail();
  const view = controls();
  await waitFor(() =>
    expect(
      view.chat
        .getByRole("button", { name: "Take control" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(view.chat.getByRole("button", { name: "Take control" }));
  expect(await view.chat.findByRole("alert")).toBeTruthy();
  expect(view.sidebar.getByRole("alert")).toBeTruthy();
  backend.recover();
  fireEvent.click(view.sidebar.getByRole("button", { name: "Take control" }));
  expect(
    await view.chat.findByRole("button", { name: "Keep control" }),
  ).toBeTruthy();
  expect(view.chat.queryByRole("alert")).toBeNull();
});

test("active human control is offered as Keep control, off, on mounting either surface, never as Hand back", async () => {
  server("human");
  const view = controls();
  const chat = await view.chat.findByRole("button", { name: "Keep control" });
  const sidebar = view.sidebar.getByRole("button", { name: "Keep control" });
  expect(chat.getAttribute("aria-pressed")).toBe("false");
  expect(sidebar.getAttribute("aria-pressed")).toBe("false");
  expect(view.queryByRole("button", { name: "Hand back" })).toBeNull();
});

test("Keep control is a toggle its caller holds, and pressing it changes nothing on the computer", async () => {
  const backend = server("human");
  function Viewer() {
    const [keep, setKeep] = useState(false);
    return (
      <ComputerControlButton
        computerId="keep-control"
        keepControl={keep}
        onKeepControlChange={setKeep}
      />
    );
  }
  const view = render(<Viewer />);
  const keep = await view.findByRole("button", { name: "Keep control" });
  await waitFor(() => expect(keep.hasAttribute("disabled")).toBe(false));

  fireEvent.click(keep);
  await waitFor(() => expect(keep.getAttribute("aria-pressed")).toBe("true"));
  fireEvent.click(keep);
  await waitFor(() => expect(keep.getAttribute("aria-pressed")).toBe("false"));

  // Only what minimizing does depends on it; nothing was taken, released or cancelled here.
  expect(backend.calls.filter((call) => call.body)).toHaveLength(0);
});

test("a surface without a minimize of its own offers Open screen while the person holds control", async () => {
  const backend = server("human");
  let opened = 0;
  const view = render(
    <ComputerControlButton
      computerId="card-control"
      onOpenScreen={() => {
        opened += 1;
      }}
    />,
  );

  fireEvent.click(await view.findByRole("button", { name: "Open screen" }));

  expect(opened).toBe(1);
  expect(view.queryByRole("button", { name: "Keep control" })).toBeNull();
  expect(backend.calls.filter((call) => call.body)).toHaveLength(0);
});

test("Strict Mode keeps chat and sidebar on one ownership store", async () => {
  const backend = server();
  const view = render(
    <StrictMode>
      <ComputerControlButton computerId="strict-control" />
      <ComputerControlButton computerId="strict-control" />
    </StrictMode>,
  );
  await waitFor(() =>
    expect(
      view
        .getAllByRole("button", { name: "Take control" })
        .every((button) => !button.hasAttribute("disabled")),
    ).toBe(true),
  );
  fireEvent.click(view.getAllByRole("button", { name: "Take control" })[0]!);
  await waitFor(() =>
    expect(view.getAllByRole("button", { name: "Keep control" })).toHaveLength(
      2,
    ),
  );
  expect(
    backend.calls.filter((call) => call.path.endsWith("/control/request")),
  ).toHaveLength(1);
});

test("a takeover stays shared when chat remounts before its response", async () => {
  const backend = server();
  backend.delayTake();
  const first = render(<ComputerControlButton computerId="remount-control" />);
  await waitFor(() =>
    expect(first.getByRole("button").hasAttribute("disabled")).toBe(false),
  );
  fireEvent.click(first.getByRole("button"));
  await waitFor(() =>
    expect(
      backend.calls.some((call) => call.path.endsWith("/control/take")),
    ).toBe(true),
  );
  first.unmount();
  const second = render(<ComputerControlButton computerId="remount-control" />);
  expect(second.getByRole("button").hasAttribute("disabled")).toBe(true);
  backend.finishTake();
  expect(
    await second.findByRole("button", { name: "Keep control" }),
  ).toBeTruthy();
});

test("both controls stay disabled while the current browser action drains", async () => {
  const backend = server();
  backend.transition();
  const view = controls("draining-control");
  expect(await view.chat.findByRole("status")).toBeTruthy();
  expect(view.sidebar.getByRole("status")).toBeTruthy();
  expect(
    view.chat
      .getByRole("button", { name: "Take control" })
      .hasAttribute("disabled"),
  ).toBe(true);
  expect(
    view.sidebar
      .getByRole("button", { name: "Take control" })
      .hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.click(view.chat.getByRole("button", { name: "Take control" }));
  expect(backend.calls.filter((call) => call.body)).toHaveLength(0);
});

test("in the viewer, hovering Take control explains teaching a browser workflow", async () => {
  const backend = server();
  const view = render(
    <TooltipProvider>
      <ComputerControlButton computerId="tooltip-control" withTooltip />
    </TooltipProvider>,
  );
  const button = await view.findByRole("button", { name: "Take control" });
  await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
  // Nothing is said until it is asked for.
  expect(view.queryByText("Teach a browser workflow")).toBeNull();

  await userEvent
    .setup({ document: view.container.ownerDocument })
    .hover(button);

  expect(await view.findByText("Teach a browser workflow")).toBeTruthy();
  expect(
    view.getByText(
      "Take control, record the steps, then review a skill draft. Typed values and images are omitted. Sensitive fields stay in your hands. Recording stops automatically after ten minutes.",
    ),
  ).toBeTruthy();
  // The tooltip wraps the same wheel: it still takes control.
  fireEvent.click(button);
  expect(
    await view.findByRole("button", { name: "Keep control" }),
  ).toBeTruthy();
  expect(
    backend.calls.filter((call) => call.path.endsWith("/control/take")),
  ).toHaveLength(1);
});
