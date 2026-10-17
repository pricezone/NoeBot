import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { observeToolCall } from "@/lib/computers/browsing-steps";
import {
  COMPUTER_SLEEP_MS,
  computerSleep,
  createComputerSleep,
  DEFAULT_COMPUTER_SLEEP_MS,
  type SleepClock,
  sleepAfterFrom,
  useComputerSleep,
  useConversationActivity,
} from "@/lib/computers/use-computer-sleep";
import { reportComputerActivity } from "@/lib/copilot/computer-activity";

/**
 * A Bot's computer view sleeps when nobody is using it.
 *
 * The bot panel used to ask for a screenshot every second for as long as it was open, and on the
 * shared computer every screenshot touches the browser, so an open panel kept a browser alive for
 * ever. These pin the timer (on a fake clock) and that each kind of use wakes it: the Bot reaching
 * its computer, a computer tool call, the person typing or sending, and a turn starting. The panel,
 * the viewer and the "no screenshot while asleep" half are in computer-sleep-view.test.tsx.
 */

beforeAll(() => {
  GlobalRegistrator.register({ url: "http://localhost/" });
});
afterEach(() => {
  cleanup();
  computerSleep.reset();
});
afterAll(async () => {
  await act(async () => undefined);
  GlobalRegistrator.unregister();
});

/** A clock that only moves when told, and timers that fire when it passes them. */
function fakeClock() {
  let now = 1_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  const clock: SleepClock = {
    now: () => now,
    setTimer: (run, ms) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, run });
      return id;
    },
    clearTimer: (id) => {
      timers.delete(id as number);
    },
  };
  return {
    clock,
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.run();
      }
    },
    pending: () => timers.size,
  };
}

const MINUTE = 60_000;

describe("the timer", () => {
  test("ten minutes by default, and a positive number of minutes from the environment", () => {
    expect(DEFAULT_COMPUTER_SLEEP_MS).toBe(10 * MINUTE);
    expect(sleepAfterFrom(undefined)).toBe(10 * MINUTE);
    expect(sleepAfterFrom("2")).toBe(2 * MINUTE);
    expect(sleepAfterFrom(0.5)).toBe(30_000);
    for (const value of ["", " ", "0", "-3", "soon", null]) {
      expect(sleepAfterFrom(value)).toBe(10 * MINUTE);
    }
    // Unset in the test environment, so the default is what this run uses.
    expect(COMPUTER_SLEEP_MS).toBe(
      sleepAfterFrom(process.env.VITE_COMPUTER_SLEEP_MINUTES),
    );
  });

  test("a view nobody uses goes to sleep after the interval, not before", () => {
    const time = fakeClock();
    const sleep = createComputerSleep({
      sleepMs: 10 * MINUTE,
      clock: time.clock,
    });
    sleep.watch("noe");

    time.advance(10 * MINUTE - 1);
    expect(sleep.isAsleep("noe")).toBe(false);
    time.advance(1);
    expect(sleep.isAsleep("noe")).toBe(true);
    // Nothing left running once asleep.
    expect(time.pending()).toBe(0);
  });

  test("activity starts the interval again, and wakes a sleeping view", () => {
    const time = fakeClock();
    const sleep = createComputerSleep({
      sleepMs: 10 * MINUTE,
      clock: time.clock,
    });
    sleep.watch("noe");
    time.advance(9 * MINUTE);
    sleep.activity("noe");
    time.advance(9 * MINUTE);
    expect(sleep.isAsleep("noe")).toBe(false);
    time.advance(MINUTE);
    expect(sleep.isAsleep("noe")).toBe(true);

    sleep.activity("noe");
    expect(sleep.isAsleep("noe")).toBe(false);
    time.advance(10 * MINUTE);
    expect(sleep.isAsleep("noe")).toBe(true);
  });

  test("one Bot's activity is not another's", () => {
    const time = fakeClock();
    const sleep = createComputerSleep({ sleepMs: MINUTE, clock: time.clock });
    sleep.watch("noe");
    sleep.watch("ada");
    time.advance(MINUTE / 2);
    sleep.activity("ada");
    time.advance(MINUTE / 2);
    expect(sleep.isAsleep("noe")).toBe(true);
    expect(sleep.isAsleep("ada")).toBe(false);
  });

  test("a stopped browser sleeps the view only when nothing has happened here lately", () => {
    const time = fakeClock();
    const sleep = createComputerSleep({
      sleepMs: 10 * MINUTE,
      clock: time.clock,
    });

    // Nothing has happened: the computer says its browser stopped, so the view opens asleep.
    sleep.sleepIfQuiet("noe");
    expect(sleep.isAsleep("noe")).toBe(true);

    // Just used (Wake was pressed, the Bot is browsing): awake whatever the browser is doing.
    sleep.activity("ada");
    time.advance(MINUTE);
    sleep.sleepIfQuiet("ada");
    expect(sleep.isAsleep("ada")).toBe(false);

    // Used, but longer ago than the interval: quiet again.
    sleep.activity("eve");
    time.advance(10 * MINUTE);
    sleep.activity("eve");
    time.advance(10 * MINUTE);
    sleep.sleepIfQuiet("eve");
    expect(sleep.isAsleep("eve")).toBe(true);
  });
});

describe("the hook", () => {
  test("reads asleep, re-renders on it, and wake() wakes it", () => {
    const time = fakeClock();
    const store = createComputerSleep({ sleepMs: MINUTE, clock: time.clock });
    function Probe() {
      const { asleep, wake } = useComputerSleep("noe", { store });
      return (
        <button onClick={wake} type="button">
          {asleep ? "asleep" : "awake"}
        </button>
      );
    }
    const view = render(<Probe />);
    expect(view.getByRole("button").textContent).toBe("awake");

    act(() => time.advance(MINUTE));
    expect(view.getByRole("button").textContent).toBe("asleep");

    fireEvent.click(view.getByRole("button"));
    expect(view.getByRole("button").textContent).toBe("awake");
  });

  test("a view that does not sleep reads awake and starts no timer", () => {
    const time = fakeClock();
    const store = createComputerSleep({ sleepMs: MINUTE, clock: time.clock });
    store.sleep("noe");
    function Probe() {
      const { asleep } = useComputerSleep("ada", { store, enabled: false });
      const other = useComputerSleep("noe", { store, enabled: false });
      return <p>{`${asleep} ${other.asleep}`}</p>;
    }
    const view = render(<Probe />);
    expect(view.container.textContent).toBe("false false");
    expect(time.pending()).toBe(0);
  });
});

describe("what wakes a sleeping computer", () => {
  const BOT = "sleepy-bot";

  test("the Bot reaching its computer", () => {
    computerSleep.sleep(BOT);
    reportComputerActivity(BOT);
    expect(computerSleep.isAsleep(BOT)).toBe(false);
  });

  test("another Bot reaching its own computer does not", () => {
    computerSleep.sleep(BOT);
    reportComputerActivity("someone-else");
    expect(computerSleep.isAsleep(BOT)).toBe(true);
  });

  test("a computer tool call, as it is made, whatever runs it", async () => {
    computerSleep.sleep(BOT);
    let wokenBeforeRun: boolean | undefined;
    const result = await observeToolCall(
      BOT,
      "computer_click",
      { ref: "e1", snapshotId: 1 },
      async () => {
        wokenBeforeRun = !computerSleep.isAsleep(BOT);
        return { ok: true };
      },
    );
    expect(result).toEqual({ ok: true });
    expect(wokenBeforeRun).toBe(true);
  });

  test("a tool that is not the computer's does not", async () => {
    computerSleep.sleep(BOT);
    await observeToolCall(BOT, "report_refusal", {}, async () => "Recorded.");
    expect(computerSleep.isAsleep(BOT)).toBe(true);
  });

  /** The conversation's wiring, the way ChannelChat uses it: input captured on the wrapper, and a send. */
  function Conversation({ busy }: { busy: boolean }) {
    const used = useConversationActivity(BOT, busy);
    return (
      <div onInputCapture={used}>
        <textarea aria-label="Message" />
        <button onClick={used} type="button">
          Send
        </button>
      </div>
    );
  }

  test("the person typing in the Bot's conversation", () => {
    const view = render(<Conversation busy={false} />);
    computerSleep.sleep(BOT);
    fireEvent.input(view.getByRole("textbox", { name: "Message" }), {
      target: { value: "h" },
    });
    expect(computerSleep.isAsleep(BOT)).toBe(false);
  });

  test("the person sending", () => {
    const view = render(<Conversation busy={false} />);
    computerSleep.sleep(BOT);
    fireEvent.click(view.getByRole("button", { name: "Send" }));
    expect(computerSleep.isAsleep(BOT)).toBe(false);
  });

  test("a turn starting, once, on its rising edge", () => {
    const view = render(<Conversation busy={false} />);
    computerSleep.sleep(BOT);
    view.rerender(<Conversation busy />);
    expect(computerSleep.isAsleep(BOT)).toBe(false);

    // A turn that goes on without touching the computer does not keep waking it.
    computerSleep.sleep(BOT);
    view.rerender(<Conversation busy />);
    expect(computerSleep.isAsleep(BOT)).toBe(true);
  });
});
