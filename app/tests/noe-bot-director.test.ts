import { describe, expect, test } from "bun:test";
import type { TranscriptItem } from "@/components/channels/browser-activity";
import { browserActivityOf } from "@/components/noe-bot/anim/browser-steps";
import {
  type BrowserStep,
  type DirectorState,
  INITIAL_DIRECTOR,
  outcomeFor,
  type RunSignal,
  reduceDirector,
} from "@/components/noe-bot/anim/director";
import {
  classifyIntent,
  languageOf,
  reactionFor,
} from "@/components/noe-bot/anim/intent";
import {
  animationForTool,
  browserLookFor,
} from "@/components/noe-bot/anim/tool-map";

const idle: RunSignal = {
  busy: false,
  waitingOnFirstToken: false,
  runningTool: null,
  browsing: false,
  browserSteps: [],
  streaming: false,
  replied: false,
  pendingText: null,
  stopped: null,
};
const thinking = (text = "what's the latest on bun?"): RunSignal => ({
  ...idle,
  busy: true,
  waitingOnFirstToken: true,
  pendingText: text,
});
const tool = (name: string): RunSignal => ({
  ...idle,
  busy: true,
  runningTool: name,
  pendingText: "hi",
});
/** A browser call: running until it is given a result. */
const step = (
  id: string,
  name: string,
  running = true,
  ok = false,
): BrowserStep => ({ id, tool: name, running, ok });
const done = (s: BrowserStep): BrowserStep => ({
  ...s,
  running: false,
  ok: true,
});
/** The turn is browsing and `steps` are its browser calls so far, the newest last. */
const browse = (...steps: BrowserStep[]): RunSignal => ({
  ...idle,
  busy: true,
  browsing: true,
  browserSteps: steps,
  pendingText: "hi",
});

/** Play the machine from `from` through `[signal, at]` steps and return the states seen. */
function play(
  from: DirectorState,
  steps: readonly (readonly [RunSignal, number])[],
): DirectorState[] {
  const out: DirectorState[] = [];
  let s = from;
  for (const [signal, at] of steps) {
    s = reduceDirector(s, signal, at);
    out.push(s);
  }
  return out;
}

describe("what the bot is doing → animation", () => {
  test("the running tool picks the action, the person-facing tools say waiting", () => {
    expect(animationForTool("computer_navigate")).toBe("action:search");
    expect(animationForTool("mcp__parallel__web_search")).toBe("action:search");
    expect(animationForTool("computer_read_file")).toBe("action:study");
    expect(animationForTool("read_file_content")).toBe("action:study");
    expect(animationForTool("computer_write_file")).toBe("action:writing");
    expect(animationForTool("mcp__gmail__send_email")).toBe("action:writing");
    expect(animationForTool("computer_run_command")).toBe("action:terminal");
    expect(animationForTool("host_run_command")).toBe("action:terminal");
    expect(animationForTool("showBarChart")).toBe("action:present");
    expect(animationForTool("generateSandboxedUi")).toBe("action:present");
    expect(animationForTool("mcp__vercel__deploy_project")).toBe(
      "state:servers",
    );
    expect(animationForTool("message_bot")).toBe("state:sub-agents");
    expect(animationForTool("mcp__elevenlabs__transcribe_audio")).toBe(
      "action:music",
    );
    expect(animationForTool("mcp__stripe__create_invoice")).toBe("action:cash");
    expect(animationForTool("ask_person")).toBe("waiting");
    expect(animationForTool("computer_request_sign_in")).toBe("waiting");
    expect(animationForTool("computer_request_secret")).toBe("waiting");
    expect(animationForTool("computer_request_help")).toBe("waiting");
    expect(animationForTool("askForm")).toBe("waiting");
    expect(animationForTool("something_nobody_knows")).toBe("action:type");
  });

  test("each browser step is drawn by what it does to the page", () => {
    expect(animationForTool("computer_navigate")).toBe("action:search");
    expect(animationForTool("computer_tabs")).toBe("action:search");
    expect(animationForTool("computer_back")).toBe("action:search");
    expect(animationForTool("computer_snapshot")).toBe("face:nerd");
    expect(animationForTool("computer_read")).toBe("face:nerd");
    for (const name of [
      "computer_type",
      "computer_key",
      "computer_click",
      "computer_select",
      "computer_check",
      "computer_hover",
      "computer_scroll",
    ])
      expect({ name, id: animationForTool(name) }).toEqual({
        name,
        id: "action:type",
      });
    expect(animationForTool("computer_fill")).toBe("action:turbo");
    expect(animationForTool("computer_upload")).toBe("action:writing");
    expect(animationForTool("computer_show_screen")).toBe("action:present");
    expect(animationForTool("computer_dialog")).toBe("face:curious");
    expect(animationForTool("render_a2ui")).toBe("action:present");
    // Workspace tools keep their own loops.
    expect(animationForTool("computer_read_file")).toBe("action:study");
    expect(animationForTool("computer_run_command")).toBe("action:terminal");
    expect(browserLookFor("computer_read_file")).toBeNull();
    // Writes count towards a streak; looking and scrolling do not.
    expect(browserLookFor("computer_select")?.writes).toBe(true);
    expect(browserLookFor("computer_upload")?.writes).toBe(true);
    expect(browserLookFor("computer_scroll")?.writes).toBeUndefined();
    expect(browserLookFor("computer_snapshot")?.writes).toBeUndefined();
  });
});

describe("what the person asks → sequence, in English and Greek", () => {
  test("the design's own examples land on their intents", () => {
    expect(classifyIntent("hi")?.sequence).toEqual([
      "face:happy",
      "action:greeting",
    ]);
    expect(classifyIntent("γεια")?.sequence).toEqual([
      "face:happy",
      "action:greeting",
    ]);
    expect(classifyIntent("what's the latest on React?")?.id).toBe(
      "question needing research",
    );
    expect(classifyIntent("summarise this PDF")?.id).toBe(
      "summarise / explain a document",
    );
    expect(classifyIntent("draft an email to the landlord")?.id).toBe(
      "write text",
    );
    expect(classifyIntent("write a function that parses dates")?.id).toBe(
      "code task",
    );
    expect(classifyIntent("why does this crash?")?.id).toBe("debug");
    expect(classifyIntent("γιατί σκάει η εφαρμογή;")?.id).toBe("debug");
    expect(classifyIntent("run the tests")?.id).toBe("run / test");
    expect(classifyIntent("analyse this CSV")?.id).toBe("data / analytics");
    expect(classifyIntent("make a landing page for the bakery")?.id).toBe(
      "build UI",
    );
    expect(classifyIntent("deploy to prod")?.id).toBe("deploy / infra");
    expect(classifyIntent("ανέβασε στην παραγωγή")?.id).toBe("deploy / infra");
    expect(classifyIntent("plan and build the whole feature")?.id).toBe(
      "big multi-step task",
    );
    expect(classifyIntent("process 10k rows")?.id).toBe("long-running / heavy");
    expect(classifyIntent("write a poem about rain")?.id).toBe(
      "creative / imagine",
    );
    expect(classifyIntent("price this invoice")?.id).toBe("finance");
    expect(classifyIntent("make a playlist for the road")?.id).toBe(
      "music / audio",
    );
    expect(classifyIntent("tell me a joke")?.id).toBe("games / fun");
    expect(classifyIntent("workout plan for the week")?.id).toBe(
      "fitness / motivation",
    );
    expect(classifyIntent("plan a trip to Crete")?.id).toBe(
      "travel / plans / moving",
    );
    expect(classifyIntent("thank you!")?.id).toBe("gratitude / affection");
    expect(classifyIntent("ευχαριστώ πολύ!")?.id).toBe("gratitude / affection");
    expect(classifyIntent("keep this between us")?.id).toBe(
      "secret / private info",
    );
    expect(classifyIntent("")).toBeNull();
  });

  test("a browser task reads as browsing, never as code", () => {
    for (const text of [
      "go to https://example.com and sign me up",
      "fill in the contact form on example.org",
      "open the site and book a table for two",
      "συμπλήρωσε τη φόρμα στο gov.gr",
      "μπες στο site της ΔΕΗ και κατέβασε τον λογαριασμό",
      "check the api docs at www.example.dev",
    ]) {
      const intent = classifyIntent(text);
      expect({ text, id: intent?.id }).toEqual({ text, id: "browse the web" });
      expect(intent?.sequence).not.toContain("action:type");
    }
    // Building a page is still building one.
    expect(classifyIntent("make a landing page for the bakery")?.id).toBe(
      "build UI",
    );
  });

  test("tone and language are read from the words", () => {
    expect(reactionFor("thanks a lot").face).toBe("face:in-love");
    expect(reactionFor("ugh, this is broken AGAIN!!").face).toBe(
      "face:worried",
    );
    expect(reactionFor("urgent: fix before the demo").face).toBe(
      "face:surprised",
    );
    expect(reactionFor("lol ok").face).toBe("face:laughing");
    expect(reactionFor("what do you mean??").face).toBe("face:curious");
    expect(reactionFor("please list the files").face).toBe("face:attentive");
    expect(languageOf("γεια σου")).toBe("el");
    expect(languageOf("hello")).toBe("en");
    expect(languageOf(null)).toBe("en");
  });
});

describe("the indicator's state machine", () => {
  test("a turn opens with the tone reaction, plays the intent's sequence, then goes pensive", () => {
    const ask = thinking("ugh, what's the latest on bun?");
    const [first, second, third, pensive] = play(INITIAL_DIRECTOR, [
      [ask, 100],
      [ask, 101.3],
      [ask, 102.6],
      [ask, 112],
    ]);
    expect(first?.visible).toBe(true);
    expect(first?.phase).toBe("thinking");
    // Frustrated words get the worried face for the first 600 ms…
    expect(first?.animation).toBe("face:worried");
    expect(first?.label).toBe("Thinking");
    // …then the research intent's sequence, each step held at least 1.2 s…
    expect(second?.animation).toBe("action:search");
    expect(third?.animation).toBe("action:study");
    // …and a model that still has not spoken goes pensive.
    expect(pensive?.animation).toBe("face:pensive");
    const [grateful] = play(INITIAL_DIRECTOR, [
      [thinking("thank you so much!"), 0],
    ]);
    expect(grateful?.animation).toBe("face:in-love");
  });

  test("Greek words make Greek labels", () => {
    const [s] = play(INITIAL_DIRECTOR, [[thinking("γεια σου"), 0]]);
    expect(s?.lang).toBe("el");
    expect(s?.label).toBe("Σκέφτομαι");
  });

  test("a tool call switches to its action after the minimum display, and the label names it", () => {
    const states = play(INITIAL_DIRECTOR, [
      [thinking("find the cheapest flight"), 0],
      [tool("mcp__parallel__web_search"), 0.3],
      [tool("mcp__parallel__web_search"), 0.6],
      [tool("mcp__parallel__web_search"), 1.5],
    ]);
    // Still on the first animation until 1.2 s have passed.
    expect(states[1]?.animation).toBe(states[0]?.animation);
    expect(states[2]?.animation).toBe(states[0]?.animation);
    expect(states[3]?.phase).toBe("working");
    expect(states[3]?.animation).toBe("action:search");
    expect(states[3]?.label).toBe("Searching…");
  });

  test("tool flicker is debounced: a tool must stay for 250 ms to be shown", () => {
    const base = play(INITIAL_DIRECTOR, [
      [tool("computer_read_file"), 0],
      [tool("computer_read_file"), 2],
    ]);
    const study = base[1];
    expect(study?.animation).toBe("action:study");
    const [blip, held] = play(study as DirectorState, [
      [tool("computer_run_command"), 2.1],
      [tool("computer_run_command"), 2.5],
    ]);
    expect(blip?.animation).toBe("action:study");
    expect(held?.animation).toBe("action:terminal");
  });

  test("a loop with no partner that runs long gets a breather, and after 30 s the bot is over-caffeinated", () => {
    const states = play(INITIAL_DIRECTOR, [
      [tool("computer_write_file"), 0],
      [tool("computer_write_file"), 2],
      [tool("computer_write_file"), 15],
      [tool("computer_write_file"), 22],
      [tool("computer_write_file"), 34],
    ]);
    expect(states[1]?.animation).toBe("action:writing");
    expect(states[2]?.animation).toBe("face:pensive");
    expect(states[3]?.animation).toBe("action:writing");
    expect(states[4]?.animation).toBe("state:caffeinated");
  });

  test("a long command turns to the server rack after 10 s, takes turns with it, then over-caffeinated", () => {
    const run = { ...tool("computer_run_command"), pendingText: "τρέξε το" };
    const states = play(INITIAL_DIRECTOR, [
      [run, 0],
      [run, 9],
      [run, 11],
      [run, 17],
      [run, 23],
      [run, 34],
    ]);
    expect(states[1]?.animation).toBe("action:terminal");
    expect(states[1]?.label).toBe("Εκτελώ εντολές…");
    expect(states[2]?.animation).toBe("state:servers");
    expect(states[2]?.label).toBe("Δουλεύω στον server…");
    expect(states[3]?.animation).toBe("action:terminal");
    expect(states[3]?.label).toBe("Εκτελώ εντολές…");
    expect(states[4]?.animation).toBe("state:servers");
    expect(states[5]?.animation).toBe("state:caffeinated");
  });

  test("a long browser step takes turns with its partner loop and keeps its name", () => {
    const cases = [
      [
        "computer_navigate",
        "action:search",
        "action:detective",
        "Opening the page…",
      ],
      ["computer_snapshot", "face:nerd", "action:study", "Reading the page…"],
      ["computer_type", "action:type", "action:turbo", "Filling in…"],
    ] as const;
    for (const [name, base, partner, label] of cases) {
      const signal = browse(step("a", name));
      const states = play(INITIAL_DIRECTOR, [
        [signal, 0],
        [signal, 11],
        [signal, 13],
        [signal, 19],
        [signal, 25],
        [signal, 31],
      ]);
      const seen = states.map((s) => [s.animation, s.label]);
      expect({ name, seen }).toEqual({
        name,
        seen: [
          [base, label],
          [base, label],
          [partner, label],
          [base, label],
          [partner, label],
          ["state:caffeinated", "Taking longer than usual…"],
        ],
      });
    }
  });

  test("streaming types, a person-facing tool pleads, and a finished turn ends on a check and a smile", () => {
    const streaming: RunSignal = {
      ...idle,
      busy: true,
      streaming: true,
      pendingText: "hi",
    };
    const answered: RunSignal = { ...idle, replied: true };
    const states = play(INITIAL_DIRECTOR, [
      [streaming, 0],
      [streaming, 2],
      [tool("ask_person"), 4],
      [tool("ask_person"), 5.3],
      [answered, 7],
      [answered, 8.3],
      [answered, 9.5],
    ]);
    expect(states[1]?.animation).toBe("action:type");
    expect(states[1]?.label).toBe("Replying…");
    // The tool is believed once it has stayed for the debounce, and shown once the face before it
    // has had its minimum display.
    expect(states[3]?.phase).toBe("waiting");
    expect(states[3]?.animation).toBe("face:pleading");
    expect(states[4]?.phase).toBe("done");
    expect(states[4]?.animation).toBe("state:success");
    expect(states[5]?.animation).toBe("face:happy");
    expect(states[6]?.visible).toBe(false);
    expect(states[6]?.phase).toBe("idle");
  });

  test("a turn that ends on a tool result, with no answer, leaves without a check", () => {
    const states = play(INITIAL_DIRECTOR, [
      [browse(step("n", "computer_navigate")), 0],
      [browse(done(step("n", "computer_navigate"))), 2],
      [idle, 3],
    ]);
    expect(states[1]?.phase).toBe("working");
    expect(states[2]?.phase).toBe("idle");
    expect(states[2]?.visible).toBe(false);
    expect(states.some((s) => s.animation === "state:success")).toBe(false);
  });

  test("how a turn stops picks the outcome", () => {
    expect(outcomeFor("The network connection was lost")).toEqual([
      "state:unplugged",
    ]);
    expect(outcomeFor("Request timed out")).toEqual([
      "face:weary",
      "face:sleepy",
    ]);
    expect(outcomeFor("I cannot help with that")).toEqual(["face:sad"]);
    expect(outcomeFor("Stopped")).toEqual([
      "face:unimpressed",
      "face:original",
    ]);
    expect(outcomeFor("TypeError: x is undefined")).toEqual(["face:dizzy"]);
    const [shown, gone] = play(INITIAL_DIRECTOR, [
      [{ ...idle, stopped: "Stopped" }, 0],
      [{ ...idle, stopped: "Stopped" }, 3.5],
    ]);
    expect(shown?.phase).toBe("error");
    expect(shown?.animation).toBe("face:unimpressed");
    expect(gone?.visible).toBe(false);
  });

  test("nothing running, nothing shown", () => {
    const [s] = play(INITIAL_DIRECTOR, [[idle, 0]]);
    expect(s?.visible).toBe(false);
  });
});

test("an unknown tool is drawn working, not labelled as writing code", async () => {
  const { reduceDirector, INITIAL_DIRECTOR } = await import(
    "@/components/noe-bot/anim/director"
  );
  const signal = {
    busy: true,
    waitingOnFirstToken: false,
    runningTool: "zzz_unmapped_tool",
    browsing: false,
    browserSteps: [],
    streaming: false,
    replied: false,
    stopped: null,
    pendingText: "κάνε κάτι",
  };
  let state = reduceDirector(INITIAL_DIRECTOR, signal, 0);
  for (let t = 0.5; t <= 4; t += 0.5) state = reduceDirector(state, signal, t);
  expect(state.phase).toBe("working");
  expect(state.animation).toBe("action:type");
  expect(state.label).toBe("Δουλεύω…");
});

describe("animations that follow the browser task", () => {
  test("each step draws what it does to the page, names it, and shows for at least 0.8 s", () => {
    const n1 = step("n1", "computer_navigate");
    const s1 = step("s1", "computer_snapshot");
    const c1 = step("c1", "computer_click");
    const states = play(INITIAL_DIRECTOR, [
      [browse(n1), 0],
      [browse(done(n1), s1), 0.5],
      [browse(done(n1), s1), 0.8],
      [browse(done(n1), done(s1), c1), 1.2],
      [browse(done(n1), done(s1), c1), 1.5],
      [browse(done(n1), done(s1), c1), 1.6],
    ]);
    expect(states[0]?.animation).toBe("action:search");
    expect(states[0]?.label).toBe("Opening the page…");
    // A new step is believed after the 250 ms debounce…
    expect(states[1]?.animation).toBe("action:search");
    // …and replaces a browser step that has had its 0.8 s (1.2 s for anything else).
    expect(states[2]?.animation).toBe("face:nerd");
    expect(states[2]?.label).toBe("Reading the page…");
    // Held: the nerd has been up for 0.7 s, and the label stays with what is drawn.
    expect(states[4]?.animation).toBe("face:nerd");
    expect(states[4]?.label).toBe("Reading the page…");
    expect(states[5]?.animation).toBe("action:type");
    expect(states[5]?.label).toBe("Filling in…");
  });

  test("three writes into the page within 30 s is filling a form: the PC on fire", () => {
    const t1 = step("t1", "computer_type");
    const t2 = step("t2", "computer_type");
    const k1 = step("k1", "computer_click");
    const s1 = step("s1", "computer_snapshot");
    const t3 = step("t3", "computer_select");
    const greek = (signal: RunSignal): RunSignal => ({
      ...signal,
      pendingText: "συμπλήρωσε τη φόρμα",
    });
    const states = play(INITIAL_DIRECTOR, [
      [greek(browse(t1)), 0],
      [greek(browse(done(t1), t2)), 1],
      [greek(browse(done(t1), t2)), 1.3],
      [greek(browse(done(t1), done(t2), k1)), 2],
      [greek(browse(done(t1), done(t2), k1)), 2.3],
      [greek(browse(done(t1), done(t2), done(k1), s1)), 3],
      [greek(browse(done(t1), done(t2), done(k1), s1)), 3.3],
      [greek(browse(done(t1), done(t2), done(k1), done(s1), t3)), 4],
      [greek(browse(done(t1), done(t2), done(k1), done(s1), t3)), 4.3],
    ]);
    expect(states[0]?.animation).toBe("action:type");
    expect(states[0]?.label).toBe("Συμπληρώνω…");
    expect(states[2]?.animation).toBe("action:type");
    expect(states[4]?.animation).toBe("action:turbo");
    expect(states[4]?.label).toBe("Συμπληρώνω τη φόρμα…");
    // Reading the page is not a write: the nerd, then back to the fire for the next field.
    expect(states[6]?.animation).toBe("face:nerd");
    expect(states[8]?.animation).toBe("action:turbo");
  });

  test("writes spread over more than 30 s are single fields, not a streak", () => {
    const t1 = step("t1", "computer_type");
    const t2 = step("t2", "computer_type");
    const t3 = step("t3", "computer_type");
    const states = play(INITIAL_DIRECTOR, [
      [browse(t1), 0],
      [browse(done(t1), t2), 20],
      [browse(done(t1), t2), 20.3],
      [browse(done(t1), done(t2), t3), 40],
      [browse(done(t1), done(t2), t3), 40.3],
    ]);
    expect(states[4]?.animation).toBe("action:type");
  });

  test("a whole page filled at once is the PC on fire from the start", () => {
    const [s] = play(INITIAL_DIRECTOR, [
      [browse(step("f1", "computer_fill")), 0],
    ]);
    expect(s?.animation).toBe("action:turbo");
    expect(s?.label).toBe("Filling in the form…");
  });

  test("a second look of the same kind starts on the partner loop", () => {
    const n1 = step("n1", "computer_navigate");
    const s1 = step("s1", "computer_snapshot");
    const n2 = step("n2", "computer_navigate");
    const s2 = step("s2", "computer_read");
    const states = play(INITIAL_DIRECTOR, [
      [browse(n1), 0],
      [browse(done(n1), s1), 1],
      [browse(done(n1), s1), 1.3],
      [browse(done(n1), done(s1), n2), 2.2],
      [browse(done(n1), done(s1), n2), 2.5],
      [browse(done(n1), done(s1), done(n2), s2), 3.4],
      [browse(done(n1), done(s1), done(n2), s2), 3.7],
    ]);
    expect(states[2]?.animation).toBe("face:nerd");
    expect(states[4]?.animation).toBe("action:detective");
    expect(states[4]?.label).toBe("Opening the page…");
    expect(states[6]?.animation).toBe("action:study");
    expect(states[6]?.label).toBe("Reading the page…");
  });

  test("a sign-in handed back powers the bot up for 1.5 s, then it carries on", () => {
    const n1 = done(step("n1", "computer_navigate"));
    const r1 = step("r1", "computer_request_sign_in");
    const s1 = step("s1", "computer_snapshot");
    const asking: RunSignal = {
      ...browse(n1, r1),
      runningTool: "computer_request_sign_in",
    };
    const states = play(INITIAL_DIRECTOR, [
      [asking, 0],
      [browse(n1, done(r1)), 5],
      [browse(n1, done(r1)), 5.3],
      [browse(n1, done(r1), s1), 6],
      [browse(n1, done(r1), s1), 6.5],
      [browse(n1, done(r1), s1), 6.9],
    ]);
    // Waiting on the person is unchanged.
    expect(states[0]?.phase).toBe("waiting");
    expect(states[0]?.animation).toBe("face:pleading");
    expect(states[0]?.label).toBe("Waiting for you");
    // The answer is believed after the debounce.
    expect(states[1]?.animation).toBe("face:pleading");
    expect(states[2]?.phase).toBe("working");
    expect(states[2]?.animation).toBe("state:powered-up");
    expect(states[2]?.label).toBe("Continuing…");
    // The burst holds its 1.5 s even though the next step is already in.
    expect(states[4]?.animation).toBe("state:powered-up");
    expect(states[5]?.animation).toBe("face:nerd");

    // With no next step yet, the burst ends and the bot keeps looking.
    const [, , , after] = play(INITIAL_DIRECTOR, [
      [asking, 0],
      [browse(n1, done(r1)), 5],
      [browse(n1, done(r1)), 5.3],
      [browse(n1, done(r1)), 7],
    ]);
    expect(after?.animation).toBe("action:search");
    expect(after?.label).toBe("Continuing…");

    // A request nobody answered is no hand-back.
    const lapsed = { ...r1, running: false, ok: false };
    const [, , missed] = play(INITIAL_DIRECTOR, [
      [asking, 0],
      [browse(n1, lapsed), 5],
      [browse(n1, lapsed), 5.3],
    ]);
    expect(missed?.animation).not.toBe("state:powered-up");
  });

  test("a question mid-browsing presents the screen, then waits for the person", () => {
    const n1 = step("n1", "computer_navigate");
    const ask: RunSignal = {
      ...idle,
      busy: true,
      runningTool: "askChoice",
      browserSteps: [done(n1)],
      pendingText: "hi",
    };
    const states = play(INITIAL_DIRECTOR, [
      [browse(n1), 0],
      [ask, 2],
      [ask, 2.3],
      [ask, 5],
      [ask, 5.4],
    ]);
    expect(states[2]?.phase).toBe("waiting");
    expect(states[2]?.animation).toBe("action:present");
    expect(states[2]?.label).toBe("Showing you the screen…");
    expect(states[3]?.animation).toBe("action:present");
    expect(states[4]?.animation).toBe("face:pleading");
    expect(states[4]?.label).toBe("Waiting for you");
    // Showing the screen as a step is presenting too.
    const [shown] = play(INITIAL_DIRECTOR, [
      [browse(step("v1", "computer_show_screen")), 0],
    ]);
    expect(shown?.animation).toBe("action:present");
    expect(shown?.label).toBe("Showing you the screen…");
  });

  test("a guess from the person's words is never named as the work", () => {
    // A code-sounding request plays the typing loop while thinking; when the first real step
    // arrives the loop is still held, and the label must say "Thinking", not "Writing code…".
    const states = play(INITIAL_DIRECTOR, [
      [thinking("write a script"), 0],
      [thinking("write a script"), 1.2],
      [{ ...tool("computer_navigate"), pendingText: "write a script" }, 1.5],
      [{ ...tool("computer_navigate"), pendingText: "write a script" }, 1.8],
      [{ ...tool("computer_navigate"), pendingText: "write a script" }, 2.5],
    ]);
    expect(states[1]?.animation).toBe("action:type");
    expect(states[1]?.label).toBe("Thinking");
    expect(states[3]?.phase).toBe("working");
    expect(states[3]?.animation).toBe("action:type");
    expect(states[3]?.label).toBe("Thinking");
    expect(states[4]?.animation).toBe("action:search");
    expect(states[4]?.label).toBe("Opening the page…");
    // A browser task thinks with the magnifier and the nerd.
    const ask = thinking("fill in the form on example.com");
    const seen = play(INITIAL_DIRECTOR, [
      [ask, 0],
      [ask, 1.3],
      [ask, 2.5],
    ]).map((s) => [s.animation, s.label]);
    expect(seen).toEqual([
      ["face:attentive", "Thinking"],
      ["action:search", "Thinking"],
      ["face:nerd", "Thinking"],
    ]);
  });

  test("the transcript's browser calls become the turn's steps, newest last", () => {
    const call = (id: string, name: string, result?: string) => ({
      kind: "tool" as const,
      id,
      toolCall: {
        id,
        type: "function" as const,
        function: { name, arguments: "{}" },
      },
      ...(result === undefined ? {} : { result }),
    });
    const items: TranscriptItem[] = [
      call("old", "computer_navigate", '{"ok":true}'),
      { kind: "text", id: "u", role: "user", text: "sign me up" },
      {
        kind: "browser",
        id: "g",
        steps: [
          call("n", "computer_navigate", '{"ok":true}'),
          call("t", "computer_type", '{"ok":false}'),
        ],
      },
      call("w", "computer_write_file", '{"ok":true}'),
      call("r", "computer_request_sign_in", '{"ok":true,"signedIn":true}'),
    ];
    const { steps, browsing } = browserActivityOf(items);
    // The person's message bounds the turn; workspace tools are not the browser.
    expect(steps).toEqual([
      { id: "n", tool: "computer_navigate", running: false, ok: true },
      { id: "t", tool: "computer_type", running: false, ok: false },
      { id: "r", tool: "computer_request_sign_in", running: false, ok: true },
    ]);
    expect(browsing).toBe(true);
    const asking = browserActivityOf([...items, call("q", "askChoice")]);
    expect(asking.steps).toHaveLength(3);
    expect(asking.browsing).toBe(false);
  });
});
