import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { FilesSection } from "@/components/bot-panel/files-section";
import {
  type AgentFile,
  type AgentFilesPage,
  compactAge,
  groupFilesByAge,
} from "@/lib/agents/files";

/**
 * The Library's file history: which group a file falls in, how old it reads, five rows a group
 * before "Show more", and a row that opens its file the way the conversation does.
 */

const originalFetch = globalThis.fetch;

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
afterAll(async () => {
  // Let React's scheduler drain before the window it reads `window.event` from goes away.
  await new Promise((resolve) => setTimeout(resolve, 0));
  GlobalRegistrator.unregister();
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function file(
  name: string,
  at: Date,
  overrides: Partial<AgentFile> = {},
): AgentFile {
  return {
    id: `workspace:${name}`,
    name,
    source: "workspace",
    mimeType: "text/plain",
    sizeBytes: 10,
    at: at.toISOString(),
    url: `/api/computers/bot-1/files/download?path=${encodeURIComponent(name)}`,
    thumbnailUrl: null,
    ...overrides,
  };
}

describe("how old a file reads", () => {
  const now = new Date("2026-10-10T12:00:00.000Z");
  const ago = (milliseconds: number) =>
    new Date(now.getTime() - milliseconds).toISOString();

  test("in the fewest characters: now, minutes, hours, days, years", () => {
    expect(compactAge(ago(20_000), now)).toBe("now");
    expect(compactAge(ago(5 * MINUTE), now)).toBe("5m");
    expect(compactAge(ago(59 * MINUTE), now)).toBe("59m");
    expect(compactAge(ago(3 * HOUR + 5 * MINUTE), now)).toBe("3h");
    expect(compactAge(ago(20 * DAY + 2 * HOUR), now)).toBe("20d");
    expect(compactAge(ago(400 * DAY), now)).toBe("1y");
  });

  test("a date in the future is now, and one that cannot be read is nothing", () => {
    expect(compactAge(new Date(now.getTime() + HOUR).toISOString(), now)).toBe(
      "now",
    );
    expect(compactAge("yesterday-ish", now)).toBe("");
  });
});

describe("grouping", () => {
  // Built from local parts, because "today" is the reader's own calendar day.
  const now = new Date(2026, 9, 10, 9, 0, 0);

  test("Today from the reader's midnight, the seven days before it, then Older", () => {
    const files = [
      file("this-morning.txt", new Date(2026, 9, 10, 0, 0, 1)),
      file("last-night.txt", new Date(2026, 9, 9, 23, 59, 0)),
      file("a-week-ago.txt", new Date(2026, 9, 3, 0, 0, 0)),
      file("before-that.txt", new Date(2026, 9, 2, 23, 59, 59)),
    ];
    expect(
      groupFilesByAge(files, now).map((group) => [
        group.label,
        group.files.map((entry) => entry.name),
      ]),
    ).toEqual([
      ["Today", ["this-morning.txt"]],
      ["Last 7 days", ["last-night.txt", "a-week-ago.txt"]],
      ["Older", ["before-that.txt"]],
    ]);
  });

  test("a group with nothing in it is not drawn, and the order inside a group is kept", () => {
    const files = [
      file("b.txt", new Date(2026, 8, 2)),
      file("a.txt", new Date(2026, 8, 1)),
    ];
    expect(groupFilesByAge(files, now)).toEqual([
      { id: "older", label: "Older", files },
    ]);
    expect(groupFilesByAge([], now)).toEqual([]);
  });
});

/** A server that answers the files list from these pages, in order, and records what it was asked. */
function serve(pages: AgentFilesPage[]) {
  const asked: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = String(input);
      asked.push(url);
      const cursor = new URL(url, "http://localhost").searchParams.get(
        "cursor",
      );
      const index = cursor ? Number(cursor) : 0;
      const page = pages[index];
      return page
        ? Response.json(page)
        : Response.json({ error: "No such page." }, { status: 400 });
    },
    { preconnect: originalFetch.preconnect },
  );
  return asked;
}

function draw() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <FilesSection agentId="bot-1" />
    </QueryClientProvider>,
  );
}

function group(view: ReturnType<typeof render>, label: string) {
  return within(
    view
      .getByRole("heading", { name: label })
      .closest("section") as HTMLElement,
  );
}

describe("the Library's files", () => {
  test("five rows a group, then Show more, which shows the rest of what has arrived", async () => {
    const now = Date.now();
    const today = Array.from({ length: 7 }, (_, index) =>
      file(`today-${index + 1}.txt`, new Date(now)),
    );
    const older = [
      file("old-1.txt", new Date(now - 30 * DAY)),
      file("old-2.txt", new Date(now - 31 * DAY)),
    ];
    const week = [file("this-week.txt", new Date(now - 3 * DAY))];
    serve([
      {
        files: [...today, ...week, ...older],
        nextCursor: null,
        workspace: "listed",
      },
    ]);
    const view = draw();
    await view.findByRole("heading", { name: "Today" });

    expect(
      view.getAllByRole("heading", { level: 3 }).map((h) => h.textContent),
    ).toEqual(["Today", "Last 7 days", "Older"]);
    const todays = group(view, "Today");
    expect(todays.getAllByRole("listitem")).toHaveLength(5);
    expect(todays.getByText("today-5.txt")).toBeTruthy();
    expect(todays.queryByText("today-6.txt")).toBeNull();

    fireEvent.click(todays.getByRole("button", { name: "Show more" }));
    expect(todays.getAllByRole("listitem")).toHaveLength(7);
    expect(todays.queryByRole("button", { name: "Show more" })).toBeNull();

    // The groups that fit need no button, and each row says how old it is.
    const olders = group(view, "Older");
    expect(olders.getAllByRole("listitem")).toHaveLength(2);
    expect(olders.queryByRole("button", { name: "Show more" })).toBeNull();
    expect(olders.getByText("30d")).toBeTruthy();
    expect(group(view, "Last 7 days").getByText("3d")).toBeTruthy();
    expect(todays.getAllByText("now")).toHaveLength(7);
  });

  test("the last group's Show more asks for the next page once what has arrived runs out", async () => {
    const now = Date.now();
    const first = Array.from({ length: 6 }, (_, index) =>
      file(`old-${index + 1}.txt`, new Date(now - (40 + index) * DAY)),
    );
    const second = [file("old-7.txt", new Date(now - 60 * DAY))];
    const asked = serve([
      { files: first, nextCursor: "1", workspace: "listed" },
      { files: second, nextCursor: null, workspace: "listed" },
    ]);
    const view = draw();
    await view.findByRole("heading", { name: "Older" });
    expect(asked).toEqual(["/api/agents/bot-1/files"]);

    fireEvent.click(
      group(view, "Older").getByRole("button", { name: "Show more" }),
    );
    await waitFor(() =>
      expect(group(view, "Older").getAllByRole("listitem")).toHaveLength(7),
    );
    expect(asked).toEqual([
      "/api/agents/bot-1/files",
      "/api/agents/bot-1/files?cursor=1",
    ]);
    expect(
      group(view, "Older").queryByRole("button", { name: "Show more" }),
    ).toBeNull();
  });

  test("a row opens its file: an image in the lightbox, anything else as a download", async () => {
    const now = new Date();
    const photo = file("photo.png", now, {
      id: "attachment:00000000-0000-4000-8000-000000000001",
      source: "attachment",
      mimeType: "image/png",
      url: "/api/attachments/00000000-0000-4000-8000-000000000001",
      thumbnailUrl: "/api/attachments/00000000-0000-4000-8000-000000000001",
    });
    const notes = file("notes.txt", now, {
      id: "attachment:00000000-0000-4000-8000-000000000002",
      source: "attachment",
      url: "/api/attachments/00000000-0000-4000-8000-000000000002",
    });
    const report = file("reports/q3.pdf", now, {
      name: "q3.pdf",
      mimeType: "application/pdf",
    });
    serve([
      { files: [photo, notes, report], nextCursor: null, workspace: "listed" },
    ]);
    const view = draw();
    await view.findByRole("heading", { name: "Today" });

    const opener = view.getByRole("button", { name: "Open photo.png" });
    // The picture itself is the thumbnail.
    expect(opener.querySelector("img")?.getAttribute("src")).toBe(
      photo.thumbnailUrl,
    );
    const download = view.getByRole("link", { name: /notes\.txt/ });
    expect(download.getAttribute("href")).toBe(notes.url);
    expect(download.getAttribute("download")).toBe("notes.txt");
    const saved = view.getByRole("link", { name: /q3\.pdf/ });
    expect(saved.getAttribute("href")).toBe(
      "/api/computers/bot-1/files/download?path=reports%2Fq3.pdf",
    );
    // No picture without a thumbnail: an icon stands in.
    expect(saved.querySelector("img")).toBeNull();
    expect(saved.querySelector("svg")).toBeTruthy();

    // Last, because the open dialog makes the rest of the page inert.
    fireEvent.click(opener);
    const dialog = within(await view.findByRole("dialog"));
    expect(dialog.getByRole("img", { name: "photo.png" })).toBeTruthy();
  });

  test("with no files it says what will appear, and why the computer's may be missing", async () => {
    serve([{ files: [], nextCursor: null, workspace: "off" }]);
    const view = draw();
    expect(await view.findByText(/^No files yet\./)).toBeTruthy();
    expect(
      view.getByText(
        "Files on this Bot's computer show here while the computer is on.",
      ),
    ).toBeTruthy();
    expect(view.queryByRole("heading", { level: 3 })).toBeNull();
  });

  test("a list that cannot be loaded says so", async () => {
    globalThis.fetch = Object.assign(
      async () => Response.json({ error: "Agent not found." }, { status: 404 }),
      { preconnect: originalFetch.preconnect },
    );
    const view = draw();
    expect((await view.findByRole("alert")).textContent).toBe(
      "Agent not found.",
    );
  });
});
