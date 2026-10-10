import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Tabs, TabsList, TabsPanel, TabsTrigger } from "@/components/ui/tabs";

/**
 * The tabs primitive, in both of its dresses. Base UI owns the behaviour; these assert the
 * contract the bot panel and the Marketplace rely on: the arrow keys move the selection,
 * `aria-selected` follows it, the matching panel shows, and each variant stamps its own
 * classes on the list and its triggers.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterEach(cleanup);
afterAll(() => GlobalRegistrator.unregister());

function draw(variant: "segmented" | "underline") {
  return render(
    <Tabs defaultValue="details">
      <TabsList activateOnFocus variant={variant}>
        <TabsTrigger value="details">Details</TabsTrigger>
        <TabsTrigger value="library">Library</TabsTrigger>
        <TabsTrigger value="computer">Computer</TabsTrigger>
      </TabsList>
      <TabsPanel value="details">Details body</TabsPanel>
      <TabsPanel value="library">Library body</TabsPanel>
      <TabsPanel value="computer">Computer body</TabsPanel>
    </Tabs>,
  );
}

test("arrow keys move the selection and aria-selected follows", async () => {
  const view = draw("segmented");
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  const details = view.getByRole("tab", { name: "Details" });
  const library = view.getByRole("tab", { name: "Library" });
  const computer = view.getByRole("tab", { name: "Computer" });

  expect(details.getAttribute("aria-selected")).toBe("true");
  expect(library.getAttribute("aria-selected")).toBe("false");
  expect(view.getByText("Details body")).toBeTruthy();
  expect(view.queryByText("Library body")).toBeNull();

  details.focus();
  await user.keyboard("{ArrowRight}");
  await waitFor(() =>
    expect(library.getAttribute("aria-selected")).toBe("true"),
  );
  expect(details.getAttribute("aria-selected")).toBe("false");
  expect(view.getByText("Library body")).toBeTruthy();
  expect(view.queryByText("Details body")).toBeNull();

  await user.keyboard("{ArrowRight}");
  await waitFor(() =>
    expect(computer.getAttribute("aria-selected")).toBe("true"),
  );
  await user.keyboard("{ArrowLeft}");
  await waitFor(() =>
    expect(library.getAttribute("aria-selected")).toBe("true"),
  );
});

test("clicking a tab selects it", async () => {
  const view = draw("underline");
  const user = userEvent.setup({ document: view.baseElement.ownerDocument });
  await user.click(view.getByRole("tab", { name: "Computer" }));
  await waitFor(() =>
    expect(
      view.getByRole("tab", { name: "Computer" }).getAttribute("aria-selected"),
    ).toBe("true"),
  );
  expect(view.getByText("Computer body")).toBeTruthy();
});

test("both variants render and stamp their classes", () => {
  const segmented = draw("segmented");
  const segmentedList = segmented.getByRole("tablist");
  expect(segmentedList.getAttribute("data-variant")).toBe("segmented");
  expect(segmentedList.className).toContain("rounded-full");
  // No track: the selected tab is the only grey thing, a pill on whatever is behind the list.
  expect(segmentedList.className).not.toContain("bg-");
  const segmentedTab = segmented.getByRole("tab", { name: "Details" });
  expect(segmentedTab.getAttribute("data-active")).not.toBeNull();
  expect(segmentedTab.className).toContain("data-active:bg-muted");
  cleanup();

  const underline = draw("underline");
  const underlineList = underline.getByRole("tablist");
  expect(underlineList.getAttribute("data-variant")).toBe("underline");
  expect(underlineList.className).toContain("border-b");
  const underlineTab = underline.getByRole("tab", { name: "Details" });
  expect(underlineTab.className).toContain("data-active:border-foreground");
});
