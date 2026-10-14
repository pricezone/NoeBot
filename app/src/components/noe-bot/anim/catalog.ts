/**
 * The catalogue of animations and the ids the app passes around.
 *
 * `face:<id>` holds one expression (the 18 of the brand sheet, dizzy, cool, and the 35 newer
 * ones); `action:<id>` and `state:<id>` are the design's 20 actions and 9 states, plus two segments
 * looped on their own (turbo, the end of type, and detective, the end of search); `boot` scans the
 * character in and `rest` sends it to sleep and scans it out. Ids match `avatar-map.json`.
 */

import { ACTS, SEQUENCES } from "./acts";
import { ALL_FACES, EXPRS, type ExprSection } from "./exprs";
import { ORIGINAL_FACES } from "./pixels";

export const ACTIONS = [
  "walk",
  "jump",
  "skate",
  "study",
  "writing",
  "search",
  "type",
  "logs",
  "present",
  "terminal",
  "greeting",
  "game",
  "music",
  "coffee",
  "barbell",
  "flex",
  "sparkler",
  "bubblegum",
  "heart",
  "cash",
  "turbo",
  "detective",
] as const;
export const STATE_IDS = [
  "repair",
  "servers",
  "sub-agents",
  "caffeinated",
  "powered-up",
  "success",
  "confetti",
  "finish",
  "unplugged",
] as const;

export type ActionId = (typeof ACTIONS)[number];
export type StateId = (typeof STATE_IDS)[number];
export type FaceId = string;

export type AnimationId =
  | `face:${string}`
  | `action:${ActionId}`
  | `state:${StateId}`
  | "boot"
  | "rest"
  | "idle";

export type Animation =
  | { kind: "face"; id: string }
  | { kind: "action"; id: ActionId }
  | { kind: "state"; id: StateId }
  | { kind: "boot" }
  | { kind: "rest" }
  | { kind: "idle" };

const ACTION_SET: ReadonlySet<string> = new Set(ACTIONS);
const STATE_SET: ReadonlySet<string> = new Set(STATE_IDS);
const FACE_SET: ReadonlySet<string> = new Set(ALL_FACES);

export const isFace = (id: string): boolean => FACE_SET.has(id);
export const isAction = (id: string): id is ActionId => ACTION_SET.has(id);
export const isState = (id: string): id is StateId => STATE_SET.has(id);

/** `face:neutral` → `{kind:"face", id:"neutral"}`; anything unknown falls back to the mascot's own face. */
export const parseAnimation = (id: string): Animation => {
  if (id === "boot") return { kind: "boot" };
  if (id === "rest") return { kind: "rest" };
  if (id === "idle") return { kind: "idle" };
  const colon = id.indexOf(":");
  const kind = colon < 0 ? "face" : id.slice(0, colon);
  const name = colon < 0 ? id : id.slice(colon + 1);
  if (kind === "face" && isFace(name)) return { kind: "face", id: name };
  if (kind === "action" && isAction(name)) return { kind: "action", id: name };
  if (kind === "state" && isState(name)) return { kind: "state", id: name };
  return { kind: "face", id: "original" };
};

export const animationId = (a: Animation): AnimationId => {
  switch (a.kind) {
    case "face":
      return `face:${a.id}`;
    case "action":
      return `action:${a.id}`;
    case "state":
      return `state:${a.id}`;
    case "boot":
      return "boot";
    case "rest":
      return "rest";
    case "idle":
      return "idle";
  }
};

export const BOOT_SECONDS = 3.5;
export const REST_SECONDS = 6;
/**
 * The mascot at rest: the brand sheet's "00 Neutral · original" with a glance to "01 Neutral" and
 * "02 Attentive" as variations, every 20 s.
 */
export const IDLE_SECONDS = 20;
export const IDLE_CUES: readonly (readonly [number, string])[] = [
  [0, "original"],
  [7, "neutral"],
  [8.5, "original"],
  [15, "attentive"],
  [16.5, "original"],
];

/** How long one pass of an animation lasts; a face hold has no end (`Infinity`). */
export const durationOf = (a: Animation): number => {
  switch (a.kind) {
    case "face":
      return Number.POSITIVE_INFINITY;
    case "action":
    case "state":
      return SEQUENCES[a.id]?.duration ?? 3;
    case "boot":
      return BOOT_SECONDS;
    case "rest":
      return REST_SECONDS;
    case "idle":
      return IDLE_SECONDS;
  }
};

/** The act that plays at `t` inside an action or state, with its local time. */
export const segmentAt = (
  a: Animation,
  t: number,
): { act: string; localT: number } | null => {
  if (a.kind !== "action" && a.kind !== "state") return null;
  const seq = SEQUENCES[a.id];
  if (!seq) return null;
  const u = ((t % seq.duration) + seq.duration) % seq.duration;
  for (const [act, from, to] of seq.segments) {
    if (u >= from && u < to) return { act, localT: u - from };
  }
  const first = seq.segments[0];
  return first ? { act: first[0], localT: 0 } : null;
};

/** The design's grouping of faces for a picker: the brand sheet's 18 (+ dizzy, cool), then five sections. */
export type FaceGroup = {
  id: "original" | ExprSection;
  label: string;
  faces: readonly string[];
};

export const FACE_GROUPS: readonly FaceGroup[] = (() => {
  const groups: FaceGroup[] = [
    { id: "original", label: "Original", faces: ORIGINAL_FACES },
  ];
  const sections: ExprSection[] = [
    "Affection",
    "Playful",
    "Unwell",
    "Distress",
    "Relief",
  ];
  for (const sec of sections) {
    groups.push({
      id: sec,
      label: sec,
      faces: Object.entries(EXPRS)
        .filter(([, d]) => d.sec === sec)
        .map(([k]) => k),
    });
  }
  return groups;
})();

/** "in-love" → "In love". */
export const faceLabel = (face: string): string => {
  const words = face.split("-").join(" ");
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export type Lang = "en" | "el";

/** The short label shown beside an animation (README §4.6: always pair it with text). */
export const LABELS: Record<Lang, Record<string, string>> = {
  en: {
    "action:search": "Searching…",
    "action:study": "Reading…",
    "action:writing": "Writing…",
    "action:type": "Writing code…",
    "action:terminal": "Running commands…",
    "action:logs": "Going through the data…",
    "action:present": "Building the page…",
    "action:greeting": "Translating…",
    "action:sparkler": "Creating…",
    "action:cash": "Working out the numbers…",
    "action:music": "Working on the audio…",
    "action:coffee": "Still working…",
    "action:walk": "Planning the route…",
    "action:skate": "Planning the route…",
    "action:jump": "Getting ready…",
    "action:game": "Playing…",
    "action:barbell": "Getting pumped…",
    "action:flex": "Getting pumped…",
    "action:bubblegum": "Taking a moment…",
    "action:heart": "Aww…",
    "action:turbo": "Filling in the form…",
    "action:detective": "Investigating…",
    "state:servers": "Working on the infrastructure…",
    "state:repair": "Fixing it…",
    "state:sub-agents": "Working with other Bots…",
    "state:caffeinated": "Taking longer than usual…",
    "state:powered-up": "Going all in…",
    "state:success": "Done",
    "state:confetti": "Done!",
    "state:finish": "All done",
    "state:unplugged": "Connection lost",
    "face:attentive": "Listening…",
    "face:curious": "Thinking…",
    "face:pensive": "Thinking…",
    "face:pleading": "Waiting for you",
    "face:confused": "Needs clarification",
    "face:dizzy": "Something went wrong",
    "face:weary": "Taking too long",
    "face:sleepy": "Timed out",
    "face:sad": "Can't help with that",
    "face:unimpressed": "Stopped",
    "face:happy": "Done",
    "phase:thinking": "Thinking",
    "phase:working": "Working…",
    "phase:streaming": "Replying…",
    "phase:waiting": "Waiting for you",
    "phase:done": "Done",
    // A browser step is named by what it does to the page, whichever loop draws it.
    "step:open-page": "Opening the page…",
    "step:read-page": "Reading the page…",
    "step:fill": "Filling in…",
    "step:show-screen": "Showing you the screen…",
    "step:upload": "Uploading the file…",
    "step:dialog": "Answering the page…",
    "step:tabs": "Switching windows…",
    "step:back": "Going back…",
    "step:continue": "Continuing…",
    "step:server": "Working on the server…",
    "step:guide": "Showing you where…",
  },
  el: {
    "action:search": "Αναζήτηση…",
    "action:study": "Διάβασμα…",
    "action:writing": "Γράφω…",
    "action:type": "Γράφω κώδικα…",
    "action:terminal": "Εκτελώ εντολές…",
    "action:logs": "Ελέγχω τα δεδομένα…",
    "action:present": "Φτιάχνω τη σελίδα…",
    "action:greeting": "Μεταφράζω…",
    "action:sparkler": "Δημιουργώ…",
    "action:cash": "Κάνω τους υπολογισμούς…",
    "action:music": "Δουλεύω τον ήχο…",
    "action:coffee": "Ακόμα δουλεύω…",
    "action:walk": "Σχεδιάζω τη διαδρομή…",
    "action:skate": "Σχεδιάζω τη διαδρομή…",
    "action:jump": "Ετοιμάζομαι…",
    "action:game": "Παίζω…",
    "action:barbell": "Ζεσταίνομαι…",
    "action:flex": "Ζεσταίνομαι…",
    "action:bubblegum": "Μια στιγμή…",
    "action:heart": "Ωωω…",
    "action:turbo": "Συμπληρώνω τη φόρμα…",
    "action:detective": "Ερευνώ…",
    "state:servers": "Δουλεύω στην υποδομή…",
    "state:repair": "Το φτιάχνω…",
    "state:sub-agents": "Συνεργάζομαι με άλλα Bots…",
    "state:caffeinated": "Παίρνει περισσότερο από το συνηθισμένο…",
    "state:powered-up": "Τα δίνω όλα…",
    "state:success": "Έτοιμο",
    "state:confetti": "Έτοιμο!",
    "state:finish": "Όλα έτοιμα",
    "state:unplugged": "Χάθηκε η σύνδεση",
    "face:attentive": "Ακούω…",
    "face:curious": "Σκέφτομαι…",
    "face:pensive": "Σκέφτομαι…",
    "face:pleading": "Σε περιμένω",
    "face:confused": "Χρειάζομαι διευκρίνιση",
    "face:dizzy": "Κάτι πήγε στραβά",
    "face:weary": "Αργεί πολύ",
    "face:sleepy": "Έληξε ο χρόνος",
    "face:sad": "Δεν μπορώ να βοηθήσω σε αυτό",
    "face:unimpressed": "Σταμάτησε",
    "face:happy": "Έτοιμο",
    "phase:thinking": "Σκέφτομαι",
    "phase:working": "Δουλεύω…",
    "phase:streaming": "Απαντώ…",
    "phase:waiting": "Σε περιμένω",
    "phase:done": "Έτοιμο",
    "step:open-page": "Ανοίγω τη σελίδα…",
    "step:read-page": "Διαβάζω τη σελίδα…",
    "step:fill": "Συμπληρώνω…",
    "step:show-screen": "Σου δείχνω την οθόνη…",
    "step:upload": "Ανεβάζω το αρχείο…",
    "step:dialog": "Απαντώ στη σελίδα…",
    "step:tabs": "Αλλάζω παράθυρο…",
    "step:back": "Πάω πίσω…",
    "step:continue": "Συνεχίζω…",
    "step:server": "Δουλεύω στον server…",
    "step:guide": "Σου δείχνω πού…",
  },
};

export const labelFor = (id: string, lang: Lang): string | undefined =>
  LABELS[lang][id] ?? LABELS.en[id];

/** The animations that can play, for tests and pickers. */
export const CATALOG: readonly AnimationId[] = [
  ...ALL_FACES.map((f): AnimationId => `face:${f}`),
  ...ACTIONS.map((a): AnimationId => `action:${a}`),
  ...STATE_IDS.map((s): AnimationId => `state:${s}`),
  "boot",
  "rest",
  "idle",
];

export const hasAct = (id: string): boolean => id in ACTS;
