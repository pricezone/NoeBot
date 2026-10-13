/**
 * What an element is, read inside the page when an action on it did not work.
 *
 * Playwright says an action timed out "waiting for locator"; that was all the Bot heard, and it was
 * told the element had gone and to take another snapshot, whatever the actual reason: a cookie
 * banner in front of the button, a field that is disabled until another is filled in, a drop-down
 * that cannot be typed into. Each of those has a different next step, so this reads which one it is.
 *
 * `probeElement` runs in the page (Playwright serialises it), so it is self-contained: no imports,
 * no helpers from outside its own body. Kept free of Playwright imports so the types are shared
 * with the classifier and its tests.
 */

/** Whatever is in front of an element at the point a click would land. */
export type CoverInfo = {
  /** A short description: `a dialog "Cookies"`, `div#overlay`. */
  label: string;
  /** The first of its text, so the Bot can tell a consent banner from a spinner. */
  text: string;
  /** Looks like a cookie or consent banner, by its id, class or text. */
  consent: boolean;
  /** The labels of the buttons and links inside it, which the caller turns into refs. */
  buttons: string[];
};

export type ElementProbe = {
  connected: boolean;
  tag: string;
  /** An input's type, lower-cased; empty for anything that is not an input. */
  type: string;
  role: string;
  disabled: boolean;
  readOnly: boolean;
  /** Text can be typed into it: a text-like input, a textarea, or contenteditable. */
  editable: boolean;
  /** A checkbox, radio or switch, native or by role. */
  checkable: boolean;
  /** Says it opens a list or menu (`aria-haspopup`): the one kind of custom drop-down without a role. */
  hasPopup: boolean;
  visible: boolean;
  inViewport: boolean;
  /** For a native `<select>`: its options by label. */
  select?: { options: string[]; multiple: boolean };
  cover?: CoverInfo;
};

export function probeElement(element: Element): ElementProbe {
  const el = element as HTMLElement;
  const tag = el.tagName.toLowerCase();
  const input = el as HTMLInputElement;
  const type = tag === "input" ? (input.type || "text").toLowerCase() : "";
  const role = (el.getAttribute("role") || "").toLowerCase();
  const disabled =
    el.matches(":disabled") || el.getAttribute("aria-disabled") === "true";
  const readOnly =
    ((tag === "input" || tag === "textarea") && input.readOnly) ||
    el.getAttribute("aria-readonly") === "true";
  const notText = [
    "checkbox",
    "radio",
    "file",
    "button",
    "submit",
    "reset",
    "image",
    "range",
    "color",
    "hidden",
  ];
  const editable =
    !disabled &&
    !readOnly &&
    (el.isContentEditable ||
      tag === "textarea" ||
      (tag === "input" && !notText.includes(type)));
  const checkable =
    type === "checkbox" ||
    type === "radio" ||
    [
      "checkbox",
      "radio",
      "switch",
      "menuitemcheckbox",
      "menuitemradio",
    ].includes(role);
  const popup = (el.getAttribute("aria-haspopup") || "").toLowerCase();
  const hasPopup = popup !== "" && popup !== "false";
  const shown = (node: Element) => {
    const style = getComputedStyle(node);
    const box = node.getBoundingClientRect();
    return (
      box.width > 0 &&
      box.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none" &&
      Number(style.opacity) !== 0
    );
  };
  const rect = el.getBoundingClientRect();
  const visible = el.isConnected && shown(el);
  const inViewport =
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < innerHeight &&
    rect.left < innerWidth;
  const select =
    tag === "select"
      ? {
          options: Array.from((el as HTMLSelectElement).options)
            .map((option) => (option.label || option.text).trim())
            .filter(Boolean)
            .slice(0, 40),
          multiple: (el as HTMLSelectElement).multiple,
        }
      : undefined;

  let cover: CoverInfo | undefined;
  if (visible && inViewport) {
    const x = Math.min(Math.max(rect.left + rect.width / 2, 0), innerWidth - 1);
    const y = Math.min(
      Math.max(rect.top + rect.height / 2, 0),
      innerHeight - 1,
    );
    const root = el.getRootNode() as Document | ShadowRoot;
    const hit =
      "elementFromPoint" in root && typeof root.elementFromPoint === "function"
        ? root.elementFromPoint(x, y)
        : document.elementFromPoint(x, y);
    const isOwnLabel =
      hit instanceof HTMLLabelElement && hit.control === (el as Element);
    // An ancestor in front is the element's own box (pointer-events off), not something over it.
    if (
      hit &&
      hit !== el &&
      !el.contains(hit) &&
      !hit.contains(el) &&
      !isOwnLabel
    ) {
      let container: Element = hit;
      let node: Element | null = hit;
      while (
        node &&
        node !== document.body &&
        node !== document.documentElement
      ) {
        const style = getComputedStyle(node);
        const nodeRole = node.getAttribute("role") || "";
        if (
          style.position === "fixed" ||
          style.position === "sticky" ||
          nodeRole === "dialog" ||
          nodeRole === "alertdialog" ||
          node.getAttribute("aria-modal") === "true" ||
          node.tagName === "DIALOG"
        )
          container = node;
        node =
          node.parentElement ??
          ((node.getRootNode() as ShadowRoot).host as Element | undefined) ??
          null;
      }
      const text = ((container as HTMLElement).innerText ?? "")
        .replace(/\s+/g, " ")
        .trim();
      const className =
        typeof container.className === "string" ? container.className : "";
      const ident = `${container.id} ${className}`;
      const consent =
        /cookie|consent|gdpr|onetrust|didomi|cookiebot|usercentrics|quantcast|trustarc|\bcmp\b|privacy/i.test(
          ident,
        ) ||
        /cookie|consent|συγκατάθεση|συναίνεση|einwilligung|datenschutz/i.test(
          text.slice(0, 600),
        );
      const buttons = Array.from(
        container.querySelectorAll(
          'button, [role="button"], a[href], input[type="submit"], input[type="button"]',
        ),
      )
        .filter(shown)
        .map((button) =>
          (
            button.getAttribute("aria-label") ||
            (button as HTMLElement).innerText ||
            (button as HTMLInputElement).value ||
            ""
          )
            .replace(/\s+/g, " ")
            .trim(),
        )
        .filter((label, index, all) => label && all.indexOf(label) === index)
        .slice(0, 8);
      const containerRole = container.getAttribute("role") || "";
      const named =
        container.getAttribute("aria-label") ||
        container.querySelector("h1, h2, h3, h4, [role=heading]")
          ?.textContent ||
        "";
      const label =
        containerRole === "dialog" ||
        containerRole === "alertdialog" ||
        container.tagName === "DIALOG"
          ? `a dialog${named.trim() ? ` "${named.trim().slice(0, 60)}"` : ""}`
          : `${container.tagName.toLowerCase()}${container.id ? `#${container.id}` : className.trim() ? `.${className.trim().split(/\s+/)[0]}` : ""}`;
      cover = { label, text: text.slice(0, 160), consent, buttons };
    }
  }

  return {
    connected: el.isConnected,
    tag,
    type,
    role,
    disabled,
    readOnly,
    editable,
    checkable,
    hasPopup,
    visible,
    inViewport,
    ...(select ? { select } : {}),
    ...(cover ? { cover } : {}),
  };
}
