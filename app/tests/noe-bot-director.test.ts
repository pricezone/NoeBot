import { describe, expect, test } from "bun:test";
import {
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
import { animationForTool } from "@/components/noe-bot/anim/tool-map";

const idle: RunSignal = {
  busy: false,
  waitingOnFirstToken: false,
  runningTool: null,
  browsing: false,
  streaming: false,
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
    expect(animationForTool("something_nobody_knows")).toBe("action:type");
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

  test("a loop that runs long gets a breather, and after 30 s the bot is over-caffeinated", () => {
    const states = play(INITIAL_DIRECTOR, [
      [tool("computer_run_command"), 0],
      [tool("computer_run_command"), 2],
      [tool("computer_run_command"), 15],
      [tool("computer_run_command"), 22],
      [tool("computer_run_command"), 34],
    ]);
    expect(states[1]?.animation).toBe("action:terminal");
    expect(states[2]?.animation).toBe("face:pensive");
    expect(states[3]?.animation).toBe("action:terminal");
    expect(states[4]?.animation).toBe("state:caffeinated");
  });

  test("streaming types, a person-facing tool pleads, and a finished turn ends on a check and a smile", () => {
    const streaming: RunSignal = {
      ...idle,
      busy: true,
      streaming: true,
      pendingText: "hi",
    };
    const states = play(INITIAL_DIRECTOR, [
      [streaming, 0],
      [streaming, 2],
      [tool("ask_person"), 4],
      [tool("ask_person"), 5.3],
      [idle, 7],
      [idle, 8.3],
      [idle, 9.5],
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

  test("how a turn stops picks the outcome", () => {
    expect(outcomeFor("The network connection was lost")).toEqual([
      "state:unplugged",
    ]);
    expect(outcomeFor("Request timed out")).toEqual([
      "face:weary",
      "face:sleepy",
    ]);
    expect(outcomeFor("I cannot help with that")).toEqual(["face:sad"]);
    expect(outcomeFor("Stopped")).toEqual(["face:unimpressed", "face:neutral"]);
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
