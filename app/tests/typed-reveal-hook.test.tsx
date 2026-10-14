import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { renderHook, waitFor } from "@testing-library/react";
import { useTypedReveal } from "@/lib/typed-reveal";
import { settleReactWork } from "./settle-react-work";

/**
 * A conversation's name typing in, and then changing before it has finished: the effect for the new
 * name is not a naming and starts no reveal, so the slice the old one left behind used to stay, and
 * the row read "Υπεύθυνη δήλ" for good. The new name is drawn whole instead.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost/" }));
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

test("a name that changes while it is still typing in is drawn whole, not left cut short", async () => {
  const { result, rerender } = renderHook(
    ({ summary }: { summary: string | undefined }) => useTypedReveal(summary),
    { initialProps: { summary: undefined as string | undefined } },
  );
  rerender({ summary: "Υπεύθυνη δήλωση για τη ΔΕΔΔΗΕ" });
  await waitFor(() => expect(result.current.typing).toBe(true), {
    interval: 5,
  });

  rerender({ summary: "Υπεύθυνη δήλωση για τη ΔΕΔΔΗΕ και το ρεύμα" });

  await waitFor(() =>
    expect(result.current).toEqual({
      text: "Υπεύθυνη δήλωση για τη ΔΕΔΔΗΕ και το ρεύμα",
      typing: false,
    }),
  );
});
