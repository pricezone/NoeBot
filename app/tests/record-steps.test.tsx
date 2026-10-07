import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RecordStepsButton } from "@/components/computer/record-steps-button";
import { refreshDemonstrations } from "@/components/computer/demonstration-recorder";
import { queryClient } from "@/query-client";
import { settleReactWork } from "./settle-react-work";

/**
 * Record your steps, then name the workflow.
 *
 * One press records: a person who is not driving takes control first, and the recording starts
 * under a placeholder title, because the start route needs one and nobody can name a workflow they
 * have not done yet. The name is asked for once it stops — by hand or at the ten-minute limit — and
 * the same dialog carries on into the skill review.
 */

type Call = { method: string; url: string; body: unknown };
type Recording = {
  id: string;
  title: string;
  status: "recording" | "stopped" | "drafted" | "published";
  steps: number;
};

const calls: Call[] = [];
let holder: "bot" | "human" = "bot";
let recordings: Recording[] = [];
const originalFetch = globalThis.fetch;

function listed(recording: Recording) {
  return {
    id: recording.id,
    botId: "recording-bot",
    title: recording.title,
    status: recording.status,
    actions: Array.from({ length: recording.steps }, () => ({
      kind: "click",
      target: { role: "button", name: "Search", sensitive: false },
    })),
    draft: null,
    skillSlug: null,
    createdAt: new Date().toISOString(),
    finishedAt: null,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    maxDurationMs: 600_000,
    reachedTimeLimit: false,
  };
}

function control() {
  return {
    holder,
    since: "2026-10-07T09:00:00Z",
    requested: false,
    transitioning: false,
    resumeSnapshotRequired: false,
    request: {
      id: "request-1",
      status: holder === "human" ? "taken" : "waiting",
      reason: "I want to take control of the browser.",
      source: "manual",
      createdAt: "2026-10-07T09:00:00Z",
      updatedAt: "2026-10-07T09:00:00Z",
    },
  };
}

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });
    if (url.endsWith("/control/take")) holder = "human";
    if (url.includes("/control")) return Response.json(control());
    if (url === "/api/demonstrations" && method === "POST") {
      const started: Recording = {
        id: "d1",
        title: (body as { title: string }).title,
        status: "recording",
        steps: 0,
      };
      recordings = [started];
      return Response.json({ demonstration: listed(started) }, { status: 201 });
    }
    const one = url.match(/^\/api\/demonstrations\/([^/?]+)(\/\w+)?$/);
    const recording = recordings.find((value) => value.id === one?.[1]);
    if (one && recording) {
      if (one[2] === "/stop") recording.status = "stopped";
      if (method === "PATCH")
        recording.title = (body as { title: string }).title;
      if (method === "DELETE") {
        recordings = recordings.filter((value) => value !== recording);
        return new Response(null, { status: 204 });
      }
      if (one[2] === "/draft") {
        recording.status = "drafted";
        return Response.json({
          draft: {
            slug: "find-an-invoice",
            title: recording.title,
            summary: "Follow the browser workflow you demonstrated.",
            instructions: "Follow this reviewed browser demonstration.",
            tools: [],
            requiredTools: ["computer_click"],
            sourceRecordingId: recording.id,
          },
        });
      }
      return Response.json({ demonstration: listed(recording) });
    }
    if (url.startsWith("/api/demonstrations?"))
      return Response.json({ demonstrations: recordings.map(listed) });
    return Response.json({ error: "Not here" }, { status: 404 });
  }) as typeof fetch;
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  calls.length = 0;
  holder = "bot";
  recordings = [];
});

afterAll(async () => {
  await settleReactWork();
  globalThis.fetch = originalFetch;
  GlobalRegistrator.unregister();
});

function draw(botId: string, driving: boolean) {
  const changes: number[] = [];
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RecordStepsButton
        botId={botId}
        driving={driving}
        onRecordingChange={() => changes.push(Date.now())}
      />
    </QueryClientProvider>,
  );
  const user = userEvent.setup({ document: view.container.ownerDocument });
  return { view, user, changes };
}

const writes = () =>
  calls
    .filter((call) => call.method !== "GET")
    .map((call) => `${call.method} ${call.url.replace(/^.*\/computers/, "")}`);

test("not driving, Record your steps takes control first, then starts under the placeholder title", async () => {
  const { view, user, changes } = draw("record-take", false);
  const record = await view.findByRole("button", { name: "Record your steps" });
  // Usable once it knows who holds the wheel, as Take control is.
  await waitFor(() => expect(record.hasAttribute("disabled")).toBe(false));

  await user.click(record);

  expect(
    await view.findByRole("button", { name: "Stop recording" }),
  ).toBeTruthy();
  expect(writes()).toEqual([
    "POST /record-take/control/request",
    "POST /record-take/control/take",
    "POST /api/demonstrations",
  ]);
  expect(
    calls.find((call) => call.url === "/api/demonstrations")?.body,
  ).toEqual({ botId: "record-take", title: "Untitled workflow" });
  // The stream reconnects so the server attaches the new recording to it.
  expect(changes).toHaveLength(1);
  expect(view.getByText("0 steps")).toBeTruthy();
  expect(view.getByText(/^\d+:\d\d left$/)).toBeTruthy();
});

test("already driving, it starts recording without asking for control again", async () => {
  holder = "human";
  const { view, user } = draw("record-driving", true);

  await user.click(
    await view.findByRole("button", { name: "Record your steps" }),
  );

  await view.findByRole("button", { name: "Stop recording" });
  expect(writes()).toEqual(["POST /api/demonstrations"]);
});

test("stopping asks for the workflow's name, then renames it and opens the skill draft", async () => {
  holder = "human";
  recordings = [
    { id: "d1", title: "Untitled workflow", status: "recording", steps: 3 },
  ];
  const { view, user, changes } = draw("record-name", true);

  expect(await view.findByText("3 steps")).toBeTruthy();
  await user.click(view.getByRole("button", { name: "Stop recording" }));

  const dialog = within(await view.findByRole("dialog"));
  expect(
    dialog.getByRole("heading", { name: "Name this workflow" }),
  ).toBeTruthy();
  expect(dialog.getByText(/3 steps recorded/)).toBeTruthy();
  const name = dialog.getByLabelText("Workflow name") as HTMLInputElement;
  expect(name.value).toBe("");
  expect(name.placeholder).toBe("Find an invoice");
  expect(name.maxLength).toBe(120);
  expect(name.required).toBe(true);
  expect(
    dialog.getByRole("button", { name: "Save" }).hasAttribute("disabled"),
  ).toBe(true);

  await user.click(name);
  await user.keyboard("Find an invoice");
  await user.click(dialog.getByRole("button", { name: "Save" }));

  expect(
    await dialog.findByRole("heading", { name: "Review and edit the skill" }),
  ).toBeTruthy();
  expect(
    dialog.getByRole("button", { name: "Save and use with this Bot" }),
  ).toBeTruthy();
  expect(writes()).toEqual([
    "POST /api/demonstrations/d1/stop",
    "PATCH /api/demonstrations/d1",
    "POST /api/demonstrations/d1/draft",
  ]);
  expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({
    title: "Find an invoice",
  });
  expect(changes).toHaveLength(1);
});

test("Later closes the dialog and keeps the recording, unnamed", async () => {
  holder = "human";
  recordings = [
    { id: "d1", title: "Untitled workflow", status: "recording", steps: 2 },
  ];
  const { view, user } = draw("record-later", true);

  await user.click(await view.findByRole("button", { name: "Stop recording" }));
  const dialog = within(await view.findByRole("dialog"));
  await user.click(dialog.getByRole("button", { name: "Later" }));

  await waitFor(() => expect(view.queryAllByRole("dialog")).toHaveLength(0));
  expect(writes()).toEqual(["POST /api/demonstrations/d1/stop"]);
  expect(recordings).toEqual([
    { id: "d1", title: "Untitled workflow", status: "stopped", steps: 2 },
  ]);
  expect(view.getByRole("button", { name: "Record your steps" })).toBeTruthy();
});

test("a recording with no steps says so and offers Delete", async () => {
  holder = "human";
  recordings = [
    { id: "d1", title: "Untitled workflow", status: "recording", steps: 0 },
  ];
  const { view, user } = draw("record-empty", true);

  await user.click(await view.findByRole("button", { name: "Stop recording" }));
  const dialog = within(await view.findByRole("dialog"));
  expect(dialog.getByText(/No steps were recorded/)).toBeTruthy();
  expect(dialog.queryByLabelText("Workflow name")).toBeNull();
  await user.click(dialog.getByRole("button", { name: "Delete" }));

  await waitFor(() => expect(view.queryAllByRole("dialog")).toHaveLength(0));
  expect(writes()).toEqual([
    "POST /api/demonstrations/d1/stop",
    "DELETE /api/demonstrations/d1",
  ]);
  expect(recordings).toEqual([]);
});

test("a recording the server stopped at its limit asks for the name too", async () => {
  holder = "human";
  recordings = [
    { id: "d1", title: "Untitled workflow", status: "recording", steps: 4 },
  ];
  const { view, changes } = draw("record-limit", true);
  await view.findByRole("button", { name: "Stop recording" });

  // Nobody pressed stop: the next read finds it stopped.
  const [only] = recordings;
  if (only) only.status = "stopped";
  await act(async () => {
    await refreshDemonstrations("record-limit");
  });

  const dialog = within(await view.findByRole("dialog"));
  expect(
    dialog.getByRole("heading", { name: "Name this workflow" }),
  ).toBeTruthy();
  expect(dialog.getByText(/4 steps recorded/)).toBeTruthy();
  expect(changes).toHaveLength(1);
  expect(writes()).toEqual([]);
});
