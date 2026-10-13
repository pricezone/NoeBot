import { expect, test } from "bun:test";
import { withProfilePreferences } from "../src/profile-preferences";

test("keeps WebRTC inside the proxy and everything else the profile remembers", () => {
  const next = withProfilePreferences({
    profile: { name: "Bot" },
    webrtc: { multiple_routes_enabled: false },
  });
  expect(next).toMatchObject({
    profile: { name: "Bot" },
    webrtc: {
      multiple_routes_enabled: false,
      ip_handling_policy: "disable_non_proxied_udp",
    },
  });
});

test("on a desktop, the Home button is shown and goes to the start page", () => {
  const next = withProfilePreferences(
    { browser: { window_placement: { maximized: true } } },
    { homepage: "https://www.google.com/" },
  );
  expect(next.homepage).toBe("https://www.google.com/");
  expect(next.homepage_is_newtabpage).toBe(false);
  expect(next.browser).toEqual({
    window_placement: { maximized: true },
    show_home_button: true,
  });
});

test("applying it twice changes nothing the second time", () => {
  const once = withProfilePreferences(
    {},
    { homepage: "https://www.google.com/" },
  );
  expect(
    withProfilePreferences(once, { homepage: "https://www.google.com/" }),
  ).toEqual(once);
});

test("the Bot's browser keeps no passwords and offers to keep none", () => {
  const prefs = withProfilePreferences({ profile: { name: "Bot" } });
  expect(prefs.credentials_enable_service).toBe(false);
  expect(prefs.credentials_enable_autosignin).toBe(false);
  expect(prefs.profile).toMatchObject({
    name: "Bot",
    password_manager_enabled: false,
  });
  expect(prefs.autofill).toMatchObject({
    profile_enabled: false,
    credit_card_enabled: false,
  });
});
