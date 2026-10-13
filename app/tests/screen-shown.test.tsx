import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, waitFor } from "@testing-library/react";
import { ScreenShown } from "@/components/chat-cards/screen-shown";

/*
 * The Bot showing the person its screen before it asks to submit: the picture of the page, kept on
 * the server under the tool call and read back from there, so a reload and a second tab show it too.
 * In the gov.gr run the Bot had no way to do this and rebuilt the preview as a generated interface,
 * which drew raw JSON (O19).
 */
beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

function serveFrame(frame: { url: string; frame: string } | null) {
  const original = global.fetch;
  const asked: string[] = [];
  global.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0]) => {
      asked.push(String(path));
      return new Response(
        JSON.stringify({ frame: frame ? { ...frame, title: null } : null }),
        { headers: { "content-type": "application/json" } },
      );
    },
    { preconnect: original.preconnect },
  ) as typeof fetch;
  return {
    asked,
    restore: () => {
      global.fetch = original;
    },
  };
}

test("shows the kept picture of the page with its caption and host", async () => {
  const server = serveFrame({
    url: "https://dilosi.services.gov.gr/preview",
    frame: "iVBORw0KGgo",
  });
  try {
    const view = render(
      <ScreenShown
        caption="Προεπισκόπηση δήλωσης"
        computerId="assistant"
        result={JSON.stringify({
          ok: true,
          url: "https://dilosi.services.gov.gr/preview",
        })}
        running={false}
        toolCallId="call-shot"
      />,
    );

    const image = await waitFor(() =>
      view.getByRole("img", { name: "Προεπισκόπηση δήλωσης" }),
    );
    expect(image.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo");
    expect(view.getByText("dilosi.services.gov.gr")).toBeTruthy();
    expect(server.asked).toEqual([
      "/api/computers/assistant/page-frame/call-shot",
    ]);
  } finally {
    server.restore();
  }
});

test("a picture that could not be taken says why", () => {
  const view = render(
    <ScreenShown
      computerId="assistant"
      result={{ ok: false, reason: "Nothing is open in your browser yet." }}
      running={false}
      toolCallId="call-none"
    />,
  );

  expect(view.getByText("Showed you the screen, didn't work")).toBeTruthy();
  expect(view.getByText("Nothing is open in your browser yet.")).toBeTruthy();
});

test("a picture no longer kept names the page instead", async () => {
  const server = serveFrame(null);
  try {
    const view = render(
      <ScreenShown
        computerId="assistant"
        result={{ ok: true, url: "https://www.gov.gr/" }}
        running={false}
        toolCallId="call-gone"
      />,
    );

    await waitFor(() =>
      expect(view.getByText("Showed you www.gov.gr")).toBeTruthy(),
    );
  } finally {
    server.restore();
  }
});
