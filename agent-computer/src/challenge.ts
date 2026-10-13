import type { Frame, Page } from "playwright";
import type { BrowserChallenge } from "../../shared/computer-control";
import type { Control } from "./control";

type Signal = {
  cfMitigated?: string | null;
  text: string;
  visibleChallengeControl: boolean;
  /**
   * A challenge vendor's own widget or interstitial, visible on the page: Cloudflare Turnstile or
   * its "Just a moment" page, reCAPTCHA, hCaptcha, Arkose/FunCaptcha, DataDome, HUMAN/PerimeterX or
   * AWS WAF. Their markup is specific enough to stand on its own, where the language test below
   * needs a visible control beside it.
   */
  vendor?: ChallengeVendor;
};

export type ChallengeVendor =
  | "cloudflare"
  | "turnstile"
  | "recaptcha"
  | "hcaptcha"
  | "arkose"
  | "datadome"
  | "perimeterx"
  | "aws-waf";

type Classification = Omit<BrowserChallenge, "requestId">;

const VENDOR_NAMES: Record<ChallengeVendor, string> = {
  cloudflare: "a Cloudflare security check",
  turnstile: "a Cloudflare Turnstile check",
  recaptcha: "a reCAPTCHA",
  hcaptcha: "an hCaptcha",
  arkose: "an Arkose (FunCaptcha) puzzle",
  datadome: "a DataDome check",
  perimeterx: "a HUMAN (PerimeterX) press-and-hold check",
  "aws-waf": "an AWS WAF CAPTCHA",
};

/**
 * "Prove you are a person", in the languages Bots here are used in.
 *
 * Specific phrases rather than single words: "captcha" or "robot" alone is an article about them,
 * and an article must not open a takeover.
 */
const HUMAN_CHECK_TEXT = new RegExp(
  [
    // English
    "verify (?:that )?you (?:are|'re) (?:a )?human",
    "confirm (?:that )?you (?:are|'re) (?:a )?human",
    "i(?:'|’)m not a robot",
    "complete (?:the|this) (?:captcha|security check)",
    "select all (?:images|squares)",
    "prove (?:that )?you (?:are|'re) (?:a )?human",
    "press (?:&|and) hold",
    // Greek
    "επαληθε[υύ]στε (?:ότι|πως) είστε άνθρωπος",
    "επιβεβαι[ωώ]στε (?:ότι|πως) είστε άνθρωπος",
    "δεν είμαι ρομπότ",
    // German
    "bestätigen sie, dass sie ein mensch sind",
    "ich bin kein roboter",
    // French
    "v[ée]rifie[zr]? que vous [êe]tes (?:un )?humain",
    "confirmez que vous [êe]tes (?:un )?humain",
    "je ne suis pas un robot",
    // Spanish
    "verifica(?:r)? que eres (?:un )?humano",
    "verifique que (?:es|eres) (?:un ser )?humano",
    "no soy un robot",
    // Italian
    "verifica di essere (?:un essere )?umano",
    "non sono un robot",
    // Portuguese
    "verifique (?:se|que) (?:você )?é humano",
    "não sou um robô",
    // Dutch
    "bevestig dat je een mens bent",
    "ik ben geen robot",
    // Polish
    "potwierdź, że jesteś człowiekiem",
    "nie jestem robotem",
    // Turkish
    "robot olmadığınızı doğrulayın",
    "ben robot değilim",
    // Russian
    "подтвердите, что вы человек",
    "я не робот",
  ].join("|"),
  "i",
);

/** Generic access denial and score-only blocks offer no actionable human challenge. */
export function classifyChallenge(signal: Signal): Classification | undefined {
  if (signal.cfMitigated?.trim().toLowerCase() === "challenge")
    return {
      kind: "cloudflare",
      reason:
        "This site presented a Cloudflare security challenge. Please complete it in the existing browser, then hand control back.",
    };
  if (signal.vendor) {
    return {
      kind:
        signal.vendor === "cloudflare" || signal.vendor === "turnstile"
          ? "cloudflare"
          : "visible-challenge",
      reason: `This page shows ${VENDOR_NAMES[signal.vendor]}. Please complete it in the existing browser, then hand control back.`,
    };
  }
  if (signal.visibleChallengeControl && HUMAN_CHECK_TEXT.test(signal.text)) {
    return {
      kind: "visible-challenge",
      reason:
        "This page has a visible human verification challenge. Please complete it in the existing browser, then hand control back.",
    };
  }
}

/**
 * What one frame shows, read inside it. Runs in the page, so it is self-contained.
 *
 * Every frame is asked rather than only the top one: a Turnstile or an hCaptcha is an iframe of its
 * own, and a site that puts its whole login in a frame puts the challenge there too.
 */
function readFrame(): {
  text: string;
  visibleChallengeControl: boolean;
  vendor?: ChallengeVendor;
} {
  const visible = (element: Element) => {
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      Number(style.opacity) !== 0 &&
      bounds.width > 0 &&
      bounds.height > 0 &&
      bounds.bottom > 0 &&
      bounds.right > 0 &&
      bounds.top < innerHeight &&
      bounds.left < innerWidth
    );
  };
  const FRAME_VENDORS: Array<[RegExp, ChallengeVendor]> = [
    [/challenges\.cloudflare\.com\/.*turnstile/i, "turnstile"],
    [/challenges\.cloudflare\.com\//i, "cloudflare"],
    [/(?:google\.com|recaptcha\.net)\/recaptcha/i, "recaptcha"],
    [/hcaptcha\.com\//i, "hcaptcha"],
    [/(?:arkoselabs\.com|funcaptcha\.com)\//i, "arkose"],
    [/captcha-delivery\.com\//i, "datadome"],
    [/(?:px-cloud\.net|perimeterx\.net|px-cdn\.net)\/.*captcha/i, "perimeterx"],
    [/awswaf\.com\//i, "aws-waf"],
  ];
  const WIDGET_VENDORS: Array<[string, ChallengeVendor]> = [
    [".cf-turnstile, #cf-turnstile", "turnstile"],
    ["#challenge-form, #cf-challenge-running, #challenge-stage", "cloudflare"],
    // A div, not the button an invisible reCAPTCHA or hCaptcha is bound to.
    ['div.g-recaptcha:not([data-size="invisible"])', "recaptcha"],
    ['div.h-captcha:not([data-size="invisible"])', "hcaptcha"],
    ["#FunCaptcha, #arkose", "arkose"],
    ["#px-captcha", "perimeterx"],
    ["awswaf-captcha, #captcha-container[data-aws-waf]", "aws-waf"],
  ];
  let vendor: ChallengeVendor | undefined;
  for (const frame of Array.from(document.querySelectorAll("iframe[src]"))) {
    if (!visible(frame)) continue;
    const src = frame.getAttribute("src") ?? "";
    // reCAPTCHA v3's badge and the invisible variants sit on ordinary pages and ask nothing of anyone.
    if (/invisible/i.test(src)) continue;
    const hit = FRAME_VENDORS.find(([pattern]) => pattern.test(src));
    if (hit) {
      vendor = hit[1];
      break;
    }
  }
  if (!vendor) {
    for (const [selector, name] of WIDGET_VENDORS) {
      const widget = document.querySelector(selector);
      if (widget && visible(widget)) {
        vendor = name;
        break;
      }
    }
  }
  // The pages that are nothing but a challenge, which say so in their own address or title.
  if (!vendor) {
    const title = document.title.trim().toLowerCase();
    const here = location.href;
    if (title === "just a moment..." || title.startsWith("attention required"))
      vendor = "cloudflare";
    else if (/captcha-delivery\.com\//i.test(here)) vendor = "datadome";
    else if (/awswaf\.com\//i.test(here)) vendor = "aws-waf";
    else if (/(?:arkoselabs\.com|funcaptcha\.com)\//i.test(here))
      vendor = "arkose";
    else if (/hcaptcha\.com\//i.test(here)) vendor = "hcaptcha";
    else if (/challenges\.cloudflare\.com\//i.test(here)) vendor = "turnstile";
  }
  const controls = Array.from(
    document.querySelectorAll(
      'input[type="checkbox"], [role="checkbox"], button, [role="button"]',
    ),
  );
  const visibleChallengeControl = controls.some(
    (control) =>
      visible(control) &&
      /human|not a robot|verify|captcha|άνθρωπος|ρομπότ|mensch|roboter|humain|robot|humano|umano|człowiek|робот/i.test(
        control.getAttribute("aria-label") ??
          control.closest("label")?.textContent ??
          control.textContent ??
          "",
      ),
  );
  return {
    text: (document.body?.innerText ?? "").slice(0, 20_000),
    visibleChallengeControl,
    ...(vendor ? { vendor } : {}),
  };
}

/** How long one frame may take to answer before it is left out. */
const FRAME_READ_MS = 1_500;

async function readWithin(
  frame: Frame,
): Promise<ReturnType<typeof readFrame> | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), FRAME_READ_MS);
  });
  try {
    return await Promise.race([
      frame.evaluate(readFrame).catch(() => null),
      late,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** What every frame of the page shows, combined into one signal. */
export async function readChallengeSignal(
  page: Pick<Page, "frames">,
): Promise<Signal> {
  const frames = page.frames().slice(0, 20);
  const reads = (await Promise.all(frames.map(readWithin))).filter(
    (read): read is ReturnType<typeof readFrame> => read !== null,
  );
  const vendor = reads.find((read) => read.vendor)?.vendor;
  return {
    text: reads
      .map((read) => read.text)
      .join("\n")
      .slice(0, 40_000),
    visibleChallengeControl: reads.some((read) => read.visibleChallengeControl),
    ...(vendor ? { vendor } : {}),
  };
}

/**
 * Called on navigate, read and snapshot, and after every acting call (a click or a filled form can
 * land on a challenge as easily as a navigation can). Does not solve, click, or reload a challenge:
 * a hit opens the same takeover request a Bot's own request for help would.
 */
export async function detectChallenge(
  page: Pick<Page, "frames">,
  control: Control,
  options: { cfMitigated?: string | null; toolCallId?: string } = {},
): Promise<BrowserChallenge | undefined> {
  const signal: Signal =
    options.cfMitigated?.trim().toLowerCase() === "challenge"
      ? {
          text: "",
          visibleChallengeControl: false,
          cfMitigated: options.cfMitigated,
        }
      : await readChallengeSignal(page);
  const result = classifyChallenge(signal);
  if (!result) return undefined;
  const request = control.requestHelp(
    result.reason,
    options.toolCallId,
    result.kind,
  ).request;
  if (!request)
    throw new Error("The challenge handoff did not produce a request.");
  return { ...result, requestId: request.id };
}
