import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { OpenGenerativeUIActivityRenderer } from "@copilotkit/react-core/v2";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, waitFor } from "@testing-library/react";
import { Window } from "happy-dom";
import {
  FRAME_BASE_CSS,
  FRAME_BASE_SCRIPT,
  frameOptions,
  installFrameDefaults,
  loadFrameDefaults,
  withFrameBase,
} from "@/lib/copilot/sandbox-frame";
import { settleReactWork } from "./settle-react-work";

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

// The options the SDK's renderer passes for a finished interface (react-core 1.73.1).
const generated =
  '<head><style>body{color:#0a0a0a}@media (prefers-color-scheme: dark){body{color:#fafafa}}</style></head><body><button onclick="window.print()">Print</button></body>';
const sdkOptions = {
  frameContainer: "body",
  frameContent: generated,
  allowAdditionalAttributes: "",
};

const tokens = (value: string | null | undefined) =>
  (value ?? "").split(/\s+/).filter(Boolean);

describe("the frame options", () => {
  test("add allow-modals, which window.print() needs, and never allow-same-origin", () => {
    const options = frameOptions(sdkOptions);
    expect(tokens(options.sandboxAdditionalAttributes)).toEqual([
      "allow-modals",
    ]);
    expect(options.sandboxAdditionalAttributes).not.toContain(
      "allow-same-origin",
    );
    // What the SDK chose is otherwise left alone.
    expect(options.frameContainer).toBe("body");
    expect(options.allowAdditionalAttributes).toBe("");
  });

  test("put the base document ahead of the generated stylesheet, so the generated one wins", () => {
    const content = frameOptions(sdkOptions).frameContent ?? "";
    expect(content.startsWith("<head><style data-openbot-frame-base>")).toBe(
      true,
    );
    const base = content.indexOf(FRAME_BASE_CSS);
    const own = content.indexOf("body{color:#0a0a0a}");
    expect(base).toBeGreaterThan(-1);
    expect(own).toBeGreaterThan(base);
    expect(FRAME_BASE_CSS).toContain(":where(:root){color-scheme:light dark}");
  });

  test("are the same however many times they are applied", () => {
    const once = frameOptions(sdkOptions);
    expect(frameOptions(once)).toEqual(once);
  });

  test("leave a document loaded from a URL, or one websandbox would refuse, untouched", () => {
    expect(
      frameOptions({ frameSrc: "https://example.test/" }),
    ).not.toHaveProperty("frameContent");
    expect(withFrameBase("<p>no head</p>")).toBe("<p>no head</p>");
  });
});

describe("the frame the SDK draws", () => {
  test("is sandboxed with scripts and modals only, and carries the base document", async () => {
    expect(await loadFrameDefaults()).toBe(true);
    // Installing twice must not wrap twice.
    expect(installFrameDefaults(await import("@jetbrains/websandbox"))).toBe(
      true,
    );
    const view = render(
      <OpenGenerativeUIActivityRenderer
        activityType="open-generative-ui"
        agent={null}
        content={{
          css: "p { color: #0a0a0a; }",
          cssComplete: true,
          html: ["<p>Υπεύθυνη δήλωση</p>"],
          htmlComplete: true,
          generating: false,
        }}
        message={null}
      />,
    );
    const frame = await waitFor(() => {
      const found = view.container.querySelector("iframe");
      if (!found) throw new Error("no frame yet");
      return found;
    });
    expect(tokens(frame.getAttribute("sandbox")).sort()).toEqual([
      "allow-modals",
      "allow-scripts",
    ]);
    const srcdoc = frame.getAttribute("srcdoc") ?? "";
    expect(srcdoc.split(FRAME_BASE_CSS)).toHaveLength(2);
    expect(srcdoc.indexOf(FRAME_BASE_CSS)).toBeLessThan(
      srcdoc.indexOf("p { color: #0a0a0a; }"),
    );
  });
});

describe("the base script, inside the frame", () => {
  /** A frame-like document of its own, so the script's globals never touch the test's. */
  function frame() {
    const window = new Window({ url: "about:srcdoc" });
    const { document } = window;
    document.head.innerHTML = `<style>body{color:#0a0a0a}@media (prefers-color-scheme: dark){body{color:#fafafa}}</style>`;
    new Function("window", "document", "addEventListener", FRAME_BASE_SCRIPT)(
      window,
      document,
      window.addEventListener.bind(window),
    );
    const sheet = document.styleSheets[0];
    const darkRule = () =>
      Array.from(sheet?.cssRules ?? []).find(
        (rule): rule is CSSMediaRule & typeof rule => "media" in rule,
      );
    return { window, document, darkRule };
  }

  test("prints in the light palette and puts the dark one back afterwards", () => {
    const { window, document, darkRule } = frame();
    expect(darkRule()?.media.mediaText).toContain("prefers-color-scheme");

    window.dispatchEvent(new window.Event("beforeprint"));
    expect(darkRule()?.media.mediaText).toBe("not all");
    expect(
      document.documentElement.style.getPropertyValue("color-scheme"),
    ).toBe("light");

    window.dispatchEvent(new window.Event("afterprint"));
    expect(darkRule()?.media.mediaText).toContain("prefers-color-scheme");
    expect(
      document.documentElement.style.getPropertyValue("color-scheme"),
    ).toBe("");
    window.close();
  });

  test("keeps alert, confirm and prompt as quiet as the sandbox kept them", () => {
    const { window } = frame();
    // happy-dom's Window type does not declare the three; the script defines them on the object.
    const modals = window as unknown as Record<
      "alert" | "confirm" | "prompt",
      (message: string) => unknown
    >;
    expect(modals.alert("hello")).toBeUndefined();
    expect(modals.confirm("sure?")).toBe(false);
    expect(modals.prompt("name?")).toBeNull();
    window.close();
  });
});
