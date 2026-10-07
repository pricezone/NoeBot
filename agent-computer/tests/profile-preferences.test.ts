import { expect, test } from "bun:test";
import { withProfilePreferences } from "../src/profile-preferences";

test("keeps WebRTC inside the proxy and everything else the profile remembers", () => {
  const next = withProfilePreferences({
    profile: { name: "Bot" },
    webrtc: { multiple_routes_enabled: false },
  });
  expect(next).toEqual({
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
