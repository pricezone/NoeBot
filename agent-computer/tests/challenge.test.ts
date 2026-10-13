import { expect, test } from "bun:test";
import { classifyChallenge } from "../src/challenge";

test("Cloudflare's explicit response signal requests help, generic 403 does not", () => {
  expect(
    classifyChallenge({
      cfMitigated: "challenge",
      text: "",
      visibleChallengeControl: false,
    })?.kind,
  ).toBe("cloudflare");
  expect(
    classifyChallenge({
      text: "403 Forbidden",
      visibleChallengeControl: false,
    }),
  ).toBeUndefined();
});
test("visible challenges require specific language and visible interactive evidence", () => {
  expect(
    classifyChallenge({
      text: "Verify you are human",
      visibleChallengeControl: true,
    })?.kind,
  ).toBe("visible-challenge");
  for (const text of [
    "An article about CAPTCHA",
    "Sign in to your account",
    "Access denied",
    "Unusual traffic detected",
  ]) {
    expect(
      classifyChallenge({ text, visibleChallengeControl: false }),
    ).toBeUndefined();
  }
  expect(
    classifyChallenge({
      text: "Verify you are human",
      visibleChallengeControl: false,
    }),
  ).toBeUndefined();
  expect(
    classifyChallenge({
      text: "An article about CAPTCHA",
      visibleChallengeControl: true,
    }),
  ).toBeUndefined();
});

test("a challenge vendor's own widget stands on its own, named in the reason", () => {
  expect(
    classifyChallenge({
      text: "",
      visibleChallengeControl: false,
      vendor: "turnstile",
    }),
  ).toMatchObject({ kind: "cloudflare" });
  for (const vendor of [
    "recaptcha",
    "hcaptcha",
    "arkose",
    "datadome",
    "perimeterx",
    "aws-waf",
  ] as const) {
    const found = classifyChallenge({
      text: "",
      visibleChallengeControl: false,
      vendor,
    });
    expect(found?.kind).toBe("visible-challenge");
    expect(found?.reason).toContain("complete it in the existing browser");
  }
});

test("prove-you-are-human text is recognised in the languages Bots here work in", () => {
  for (const text of [
    "Επιβεβαιώστε ότι είστε άνθρωπος",
    "Bestätigen Sie, dass Sie ein Mensch sind",
    "Vérifiez que vous êtes humain",
    "No soy un robot",
    "Non sono un robot",
    "Não sou um robô",
    "Ik ben geen robot",
    "Nie jestem robotem",
    "Подтвердите, что вы человек",
    "Press & Hold",
  ]) {
    expect(
      classifyChallenge({ text, visibleChallengeControl: true })?.kind,
    ).toBe("visible-challenge");
  }
  expect(
    classifyChallenge({ text: "Ο ρομπότ μας", visibleChallengeControl: true }),
  ).toBeUndefined();
});
