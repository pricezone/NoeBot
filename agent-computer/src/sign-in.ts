/**
 * Typing a person's login into the Bot's page, on this side of the wire.
 *
 * The private sign-in form posts a username and password to the server, the server posts them here,
 * and this types them. The Bot is never involved: it does not pick the fields, it does not see the
 * values, and what comes back says only how the page answered.
 *
 * Before a person is shown the form at all, `probeSignIn` says what the page actually asks for (a
 * login, a username alone, a one-time code, or nothing), on which origin, and with which icon, so
 * the form names the real site and is never offered for a page that has no form on it.
 *
 * ANY SITE, NOT ONE. Fields are found the way a person finds them: in the page, in its frames, inside
 * open shadow roots; a code as one field or one box per character; a username step that is really a
 * newsletter box is passed over. The words it reads by are many languages' and no portal's, kept in
 * `SIGN_IN_WORDS` below and nowhere else.
 *
 * Refusals, before anything is typed:
 *  - the page must be on the exact origin the person was asked to sign in to, so a login cannot be
 *    carried to a page that redirected somewhere else (or that the Bot navigated to afterwards);
 *  - there must be a login form on it;
 *  - a login that moves to another origin between steps (a username page sending you on to an
 *    identity provider) is not typed into there: the answer says where it went (`movedTo`), and the
 *    server, which decides what the person agreed to, asks again for that origin.
 *
 * After every submit the page is read and the answer classified (`classifySignInPage`): signed in, an
 * error the site showed (quoted), a code it now asks for, an approval it waits for on the person's
 * phone, or a security check only a person can pass.
 *
 * Every failure is one of this module's own sentences. A Playwright error can quote the call it was
 * making, and this call's arguments are a password.
 */
import type { Frame, Locator, Page } from "playwright";
import type { SignInOutcome } from "../../shared/sign-in-guidance";
import { classifyChallenge } from "./challenge";
import { chooseLivePage } from "./live-page";
import { markElementSecret, SECRET_ATTRIBUTE } from "./secret-masking";

export type SignInFillInput = {
  origin: string;
  username?: string;
  /** Absent for a page that asks for a one-time code alone. */
  password?: string;
  code?: string;
};

/** How the page answered what was sent, with the site's own message when it showed one. */
export type SignInCheck = { outcome: SignInOutcome; pageMessage?: string };

/** What the page the Bot has open asks for, read before the person is shown a form. */
export type SignInProbe = {
  url: string;
  origin: string;
  host: string;
  form: "login" | "username" | "code" | "none";
  /** The site's icon as a small data URL, read through the Bot's own browser. */
  icon?: string;
  /**
   * The page read as the answer to a login just sent. Only meaningful while one is outstanding: the
   * server reads it while a site waits for approval on the person's phone.
   */
  check?: SignInCheck;
};

export type SignInFillResult = {
  submitted: boolean;
  passwordFieldVisible: boolean;
  url: string;
  error?: string;
  outcome?: SignInOutcome;
  /** The site's message near the form (its error, say), trimmed. Never a value that was typed. */
  pageMessage?: string;
  /** The form had a "remember this device" box, and it was left unchecked. */
  rememberDeviceLeftUnchecked?: boolean;
  /**
   * The login went on to another origin that still asks for a password (or a code). Nothing was
   * typed there; the server decides whether to continue on that origin.
   */
  movedTo?: { origin: string; form: "login" | "code" };
};

const LOGIN_ATTRIBUTE = "data-openbot-login";
const STEP_TIMEOUT_MS = 15_000;

/**
 * The words pages are read by, as regular-expression sources (matched case-insensitively).
 *
 * Maintained lists, many languages, no site: a word belongs here because sites in that language use
 * it, never because one portal does. Short tokens carry their own boundaries so they do not match
 * inside longer words.
 */
export const SIGN_IN_WORDS = {
  /** A one-time-code field's name, label or placeholder. */
  code: [
    "code",
    "codice",
    "c[oó]digo",
    "κωδικ",
    "код",
    "k[oó]d",
    "コード",
    "認証",
    "验证码",
    "驗證碼",
    "校验码",
    "인증",
    "코드",
    "رمز",
    "קוד",
    "कोड",
    "(?:^|[^a-z])t?otp",
    "2fa",
    "mfa",
    "(?:^|[^a-z])sms",
    "(?:^|[^a-z])pin(?:[^a-z]|$)",
    "(?:^|[^a-z])tan(?:[^a-z]|$)",
    "v[eé]rif",
    "token",
    "passcode",
    "one[-\\s]?time",
    "security code",
    "authenticat",
    "bestätigung",
    "επιβεβαίωσ",
    "подтвержд",
  ].join("|"),
  /** Fields that say "code" and are not a sign-in code. */
  notCode: [
    "post\\s?code",
    "postal",
    "zip",
    "(?:^|[^a-z])plz(?:[^a-z]|$)",
    "postleitzahl",
    "c[oó]digo postal",
    "codice postale",
    "code postal",
    "pocztowy",
    "почтов",
    "ταχυδρομικ",
    "郵便",
    "邮编",
    "우편",
    "promo",
    "промо",
    "coupon",
    "cup[oó]n",
    "cupom",
    "kupon",
    "voucher",
    "gutschein",
    "discount",
    "rabatt",
    "descuento",
    "desconto",
    "sconto",
    "remise",
    "réduction",
    "εκπτωτικ",
    "скидк",
    "割引",
    "优惠",
    "할인",
    "gift",
    "geschenk",
    "regalo",
    "cadeau",
    "подар",
    "referral",
    "invit",
    "captcha",
    "country",
    "area\\s?code",
    "dial\\s?code",
    "search",
    "cvv",
    "cvc",
  ].join("|"),
  /** A field the site labels as the account's name or email. */
  username: [
    "user",
    "e-?mail",
    "login",
    "account",
    "identifier",
    "benutzer",
    "usuario",
    "utilizador",
    "utente",
    "utilisateur",
    "courriel",
    "correo",
    "gebruiker",
    "użytkownik",
    "пользовател",
    "логин",
    "χρήστη",
    "kullanıcı",
    "ユーザー",
    "用户",
    "用戶",
    "사용자",
    "아이디",
    "משתמש",
    "مستخدم",
  ].join("|"),
  /** A box that signs you up for mail, not in. */
  newsletter: [
    "newsletter",
    "subscri",
    "mailing list",
    "sign up for",
    "stay (?:up to date|in the loop|informed)",
    "abonn",
    "suscri",
    "subscrev",
    "iscriviti",
    "iscrizione",
    "nieuwsbrief",
    "zapisz się",
    "подпис",
    "рассылк",
    "ενημερωτικ",
    "εγγραφείτε",
    "訂閱",
    "订阅",
    "購読",
    "メルマガ",
    "뉴스레터",
    "구독",
    "النشرة",
    "ניוזלטר",
  ].join("|"),
  /** A button that sends a login or a step of one. */
  sends: [
    "log\\s?in",
    "sign\\s?in",
    "submit",
    "continue",
    "next",
    "proceed",
    "verify",
    "confirm",
    "anmelden",
    "einloggen",
    "weiter",
    "iniciar sesi",
    "entrar",
    "acceder",
    "continuar",
    "siguiente",
    "seguinte",
    "próximo",
    "accedi",
    "continua",
    "avanti",
    "connexion",
    "se connecter",
    "suivant",
    "valider",
    "inloggen",
    "aanmelden",
    "volgende",
    "doorgaan",
    "zaloguj",
    "dalej",
    "войти",
    "далее",
    "продолжить",
    "σύνδεση",
    "είσοδος",
    "συνέχεια",
    "επόμενο",
    "giriş",
    "devam",
    "logga in",
    "nästa",
    "fortsätt",
    "ログイン",
    "次へ",
    "登录",
    "登入",
    "下一步",
    "继续",
    "로그인",
    "다음",
    "계속",
    "تسجيل الدخول",
    "التالي",
    "متابعة",
    "כניסה",
    "התחבר",
    "המשך",
  ].join("|"),
  /** A button near a login that does something else: shows the password, resends, signs in elsewhere. */
  elsewhere: [
    "show",
    "hide",
    "reveal",
    "forgot",
    "resend",
    "send again",
    "new code",
    "another",
    "back",
    "cancel",
    "google",
    "apple",
    "facebook",
    "microsoft",
    "github",
    "linkedin",
    "twitter",
    "amazon",
    "yahoo",
    "sso",
    "passkey",
    "security key",
    "magic link",
    "anzeigen",
    "verbergen",
    "vergessen",
    "erneut senden",
    "zurück",
    "abbrechen",
    "mostrar",
    "ocultar",
    "olvid",
    "esquec",
    "reenviar",
    "cancelar",
    "mostra",
    "nascondi",
    "dimentic",
    "annulla",
    "afficher",
    "masquer",
    "oubli",
    "renvoyer",
    "annuler",
    "показать",
    "скрыть",
    "забыл",
    "повторно",
    "отмена",
    "εμφάνιση",
    "απόκρυψη",
    "ξεχάσατε",
    "ακύρωση",
    "表示",
    "显示",
    "隐藏",
    "忘",
    "再送",
    "重新发送",
    "보기",
    "숨기기",
    "잊",
  ].join("|"),
  /** A "remember this device" or "keep me signed in" box. */
  remember: [
    "remember",
    "trust this",
    "don'?t ask again",
    "do not ask again",
    "keep me (?:signed|logged) in",
    "stay (?:signed|logged) in",
    "merken",
    "angemeldet bleiben",
    "vertrauen",
    "recordar",
    "recuérdame",
    "lembrar",
    "mantener la sesión",
    "ricorda",
    "resta connesso",
    "se souvenir",
    "mémoriser",
    "rester connecté",
    "onthoud",
    "ingelogd blijven",
    "zapamiętaj",
    "запомн",
    "не выходить",
    "θυμήσου",
    "να με θυμάσαι",
    "παραμείνετε συνδεδεμένοι",
    "記住",
    "记住",
    "保持登录",
    "ログイン状態",
    "記憶",
    "기억",
    "로그인 상태 유지",
    "تذكر",
    "זכור",
  ].join("|"),
  /** A page that waits for the person to approve the sign-in on their phone or in an app. */
  approval: [
    "approve.{0,60}(?:phone|device|mobile|\\bapps?\\b)",
    "(?:phone|device|\\bapp\\b).{0,40}to approve",
    "check (?:your|the) (?:phone|device|mobile|\\bapp\\b)",
    "sent (?:you )?(?:a )?(?:push|notification|prompt|sign-in request|request) to",
    "(?:confirm|approve|accept|respond).{0,40}(?:in|on|with) (?:the|your) .{0,30}\\bapp\\b",
    "waiting for (?:your )?approval",
    "enter the number shown",
    "push notification",
    "(?:bestätig|freigeb|genehmig).{0,60}(?:\\bapp\\b|handy|smartphone|telefon|gerät)",
    "push-benachrichtigung",
    "aprueb.{0,60}(?:teléfono|móvil|celular|\\bapp\\b|dispositivo)",
    "revisa tu (?:teléfono|móvil|celular)",
    "aprov.{0,60}(?:celular|telemóvel|telefone|\\bapp\\b|dispositivo)",
    "verifique (?:o )?seu (?:celular|telefone|telemóvel)",
    "approuv.{0,60}(?:téléphone|mobile|appli)",
    "vérifiez votre (?:téléphone|mobile)",
    "approva.{0,60}(?:telefono|cellulare|\\bapp\\b|dispositivo)",
    "controlla il tuo (?:telefono|cellulare)",
    "keur.{0,60}goed.{0,40}(?:telefoon|\\bapp\\b)",
    "(?:zatwierdź|potwierdź).{0,60}(?:aplikacj|telefon)",
    "sprawdź (?:swój )?telefon",
    "подтверд.{0,60}(?:приложени|телефон|устройств)",
    "проверьте (?:ваш )?телефон",
    "(?:εγκρίν|έγκριση|επιβεβαιώστε).{0,60}(?:κινητ|εφαρμογ|συσκευ)",
    "ελέγξτε το κινητό",
    "onayla.{0,60}(?:uygulama|telefon)",
    "telefonunuzu kontrol",
    "(?:スマートフォン|携帯|アプリ).{0,20}(?:承認|確認)",
    "通知を送信",
    "(?:手机|应用).{0,10}(?:确认|批准)",
    "已发送通知",
    "(?:휴대폰|앱).{0,10}(?:승인|확인)",
    "알림을 보냈",
  ].join("|"),
  /**
   * A message that says something went wrong. Not "try again" and its kin: code pages say it beside
   * their resend link before anything has gone wrong.
   */
  error: [
    "incorrect",
    "invalid",
    "wrong",
    "failed",
    "not recogni[sz]ed",
    "(?:does not|doesn't|didn't|did not) match",
    "(?:couldn't|could not|can't|cannot) find",
    "no account",
    "not found",
    "expired",
    "too many",
    "locked",
    "\\berror\\b",
    "λάθος",
    "λανθασμέν",
    "άκυρ",
    "εσφαλμέν",
    "δεν βρέθηκε",
    "inválid",
    "no válid",
    "incorret",
    "erroné",
    "falsch",
    "ungültig",
    "fehlerhaft",
    "nicht korrekt",
    "errat",
    "non (?:valid|corrett)",
    "onjuist",
    "ongeldig",
    "verkeerd",
    "nieprawidłow",
    "błędn",
    "неверн",
    "неправильн",
    "ошибк",
    "hatalı",
    "geçersiz",
    "yanlış",
    "正しくありません",
    "違います",
    "間違",
    "無効",
    "エラー",
    "错误",
    "錯誤",
    "无效",
    "不正确",
    "잘못",
    "올바르지",
    "유효하지",
    "غير صحيح",
    "خطأ",
    "שגוי",
  ].join("|"),
} as const;

type ScanOptions = {
  attribute: string;
  words: Record<keyof typeof SIGN_IN_WORDS, string>;
  /** Untick a ticked "remember this device" box. Only while filling, never while looking. */
  uncheckRemember: boolean;
  /** Read the signals `challenge.ts` reads. The main frame only. */
  challenge: boolean;
  /** Only find the code boxes around the element marked `${attribute}-around`. */
  around: boolean;
};

/** What one frame shows, read in the page. */
type PageScan = {
  username: boolean;
  password: boolean;
  code: boolean;
  /** Each box's length, for a code typed a box at a time. Empty for a single field. */
  codeBoxes: number[];
  rememberDevice: boolean;
  message?: string;
  /** The message says something went wrong, in one of the error words. */
  messageIsError: boolean;
  /** The message came from an alert region or an error-styled element. */
  messageFromAlert: boolean;
  approval: boolean;
  challengeText?: string;
  challengeControl?: boolean;
  /** A visible reCAPTCHA, hCaptcha or Turnstile box (never an invisible badge). */
  challengeWidget?: boolean;
};

/**
 * Read a frame for everything the sign-in needs, and mark the fields it found for the locators.
 *
 * Runs in the page, so it is self-contained: no helper outside it, the words passed in. Elements are
 * gathered through open shadow roots, in tree order with each shadow tree in place of its host.
 *
 *  - Password: a visible `input[type=password]` that is not one box of a split code.
 *  - Username: the visible text-like input before the password in the same form, preferring one the
 *    site labels as a username or email; with no password field, a labelled one alone is the first
 *    step of a two-step login, unless it is a newsletter box (in a footer, or among subscribe words,
 *    with no button that signs in or continues).
 *  - Code: `autocomplete=one-time-code`; a numeric field 4 to 8 long; a field named or labelled with
 *    a code word and none of the words for postcodes, coupons and the like; or a row of boxes (four or
 *    more of one character, or a short group the page calls a code) typed one box at a time.
 *  - A "remember this device" box near the form, unticked while filling.
 *  - The page's message near the form, an approval it waits for, and a security check.
 */
function scanPage(options: ScanOptions): PageScan {
  const { attribute } = options;
  const pattern = (source: string) => new RegExp(source, "i");
  const words = {
    code: pattern(options.words.code),
    notCode: pattern(options.words.notCode),
    username: pattern(options.words.username),
    newsletter: pattern(options.words.newsletter),
    sends: pattern(options.words.sends),
    remember: pattern(options.words.remember),
    approval: pattern(options.words.approval),
    error: pattern(options.words.error),
  };
  const roots = new Set<Document | ShadowRoot>([document]);
  const all = (selector: string, root: ParentNode = document): Element[] => {
    const found: Element[] = [];
    const visit = (node: ParentNode) => {
      for (const element of node.querySelectorAll("*")) {
        if (element.matches(selector)) found.push(element);
        if (element.shadowRoot) {
          roots.add(element.shadowRoot);
          visit(element.shadowRoot);
        }
      }
    };
    visit(root);
    return found;
  };
  const tidy = (text: string | null | undefined) =>
    (text ?? "").replace(/\s+/g, " ").trim();
  const textOf = (element: Element | null | undefined) =>
    tidy(element?.textContent);
  const shown = (element: Element) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return (
      box.width > 0 &&
      box.height > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none"
    );
  };
  const usable = (input: HTMLInputElement) =>
    shown(input) && !input.disabled && !input.readOnly;
  const describe = (input: HTMLInputElement) => {
    const root = input.getRootNode() as Document | ShadowRoot;
    const labelledBy = (input.getAttribute("aria-labelledby") ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => textOf(root.getElementById(id)));
    return [
      input.name,
      input.id,
      input.getAttribute("placeholder"),
      input.getAttribute("aria-label"),
      input.getAttribute("autocomplete"),
      typeof input.className === "string" ? input.className : "",
      ...[...(input.labels ?? [])].map(textOf),
      ...labelledBy,
      textOf(input.closest("label")),
    ]
      .filter(Boolean)
      .join(" ");
  };
  const buttonLabel = (element: Element) =>
    [
      element.textContent,
      (element as HTMLInputElement).value,
      element.id,
      element.getAttribute("name"),
      element.getAttribute("aria-label"),
    ]
      .filter(Boolean)
      .join(" ");
  const near = (element: Element): ParentNode => {
    const form = (element as HTMLInputElement).form;
    if (form) return form;
    let node: Element = element;
    for (let depth = 0; depth < 4 && node.parentElement; depth++)
      node = node.parentElement;
    return node === element ? (element.getRootNode() as ParentNode) : node;
  };

  for (const node of all(`[${attribute}]`)) node.removeAttribute(attribute);
  const inputs = all("input") as HTMLInputElement[];
  const CODE_TYPES = ["text", "tel", "number", ""];
  const codeLike = (input: HTMLInputElement) => {
    if (!CODE_TYPES.includes(input.type)) return false;
    const text = describe(input);
    if (
      words.notCode.test(text) ||
      /\bcc-|postal|address/.test(input.autocomplete)
    )
      return false;
    if (/one-time-code/.test(input.autocomplete)) return true;
    const max = input.maxLength;
    if (input.getAttribute("inputmode") === "numeric" && max >= 4 && max <= 8)
      return true;
    if (/^(?:\\d|\[0-9\])\{[4-8](?:,[4-8])?\}$/.test(input.pattern))
      return true;
    return words.code.test(text);
  };
  const boxes = inputs.filter(
    (input) =>
      [...CODE_TYPES, "password"].includes(input.type) &&
      input.maxLength >= 1 &&
      input.maxLength <= 4 &&
      usable(input) &&
      !words.notCode.test(describe(input)),
  );
  /** The row of boxes a box belongs to, when the row reads as a code. */
  const rowOf = (box: HTMLInputElement): HTMLInputElement[] => {
    let node = box.parentElement;
    for (let depth = 0; node && depth < 4; depth++) {
      const container: Element = node;
      const members = boxes.filter((other) => container.contains(other));
      const total = members.reduce((sum, member) => sum + member.maxLength, 0);
      if (members.length > 8 || total > 8) return [];
      if (members.length >= 2 && total >= 4) {
        const single = members.every((member) => member.maxLength === 1);
        const named = words.code.test(
          `${container.getAttribute("aria-label") ?? ""} ${textOf(container).slice(0, 200)}`,
        );
        return (single && members.length >= 4) ||
          members.some(codeLike) ||
          named
          ? members
          : [];
      }
      node = node.parentElement;
    }
    return [];
  };

  if (options.around) {
    const target = all(`[${attribute}-around]`)[0] as
      | HTMLInputElement
      | undefined;
    target?.removeAttribute(`${attribute}-around`);
    const row = target && boxes.includes(target) ? rowOf(target) : [];
    row.forEach((box, index) => {
      box.setAttribute(attribute, `code-${index}`);
    });
    return {
      username: false,
      password: false,
      code: row.length > 0,
      codeBoxes: row.length > 1 ? row.map((box) => box.maxLength) : [],
      rememberDevice: false,
      messageIsError: false,
      messageFromAlert: false,
      approval: false,
    };
  }

  let codeBoxes: HTMLInputElement[] = [];
  for (const box of boxes) {
    codeBoxes = rowOf(box);
    if (codeBoxes.length) break;
  }
  const passwords = inputs.filter(
    (input) =>
      input.type === "password" &&
      input.maxLength !== 1 &&
      usable(input) &&
      !codeBoxes.includes(input),
  );
  const password =
    passwords.find((input) => /current-password/.test(input.autocomplete)) ??
    passwords[0];
  const scope: ParentNode = password
    ? (password.form ?? (password.getRootNode() as ParentNode))
    : document;
  const decoy = (input: HTMLInputElement) => {
    const around =
      input.form ??
      input.parentElement?.parentElement?.parentElement ??
      input.parentElement;
    const inFooter = Boolean(input.closest("footer, [role=contentinfo]"));
    if (
      !inFooter &&
      !words.newsletter.test(
        `${describe(input)} ${textOf(around).slice(0, 500)}`,
      )
    )
      return false;
    const buttons = around
      ? [
          ...around.querySelectorAll(
            "button, input[type=submit], input[type=button], [role=button]",
          ),
        ]
      : [];
    return !buttons.some((button) => words.sends.test(buttonLabel(button)));
  };
  const textLike = (
    (password ? all("input", scope) : inputs) as HTMLInputElement[]
  ).filter(
    (input) =>
      ["text", "email", "tel", ""].includes(input.type) &&
      usable(input) &&
      !codeBoxes.includes(input) &&
      !/one-time-code/.test(input.autocomplete) &&
      (password
        ? Boolean(
            input.compareDocumentPosition(password) &
              Node.DOCUMENT_POSITION_FOLLOWING,
          )
        : !codeLike(input)) &&
      !decoy(input),
  );
  const named = (input: HTMLInputElement) =>
    /username|email/.test(input.autocomplete) ||
    input.type === "email" ||
    words.username.test(describe(input));
  const username = password
    ? (textLike.filter(named).at(-1) ?? textLike.at(-1))
    : textLike.find(named);
  const codeField = codeBoxes.length
    ? undefined
    : (inputs.find(
        (input) =>
          input !== username &&
          usable(input) &&
          CODE_TYPES.includes(input.type) &&
          /one-time-code/.test(input.autocomplete),
      ) ??
      inputs.find(
        (input) => input !== username && usable(input) && codeLike(input),
      ));

  if (username) username.setAttribute(attribute, "username");
  if (password) password.setAttribute(attribute, "password");
  if (codeField) codeField.setAttribute(attribute, "code");
  codeBoxes.forEach((box, index) => {
    box.setAttribute(attribute, `code-${index}`);
  });

  // A "remember this device" box beside the fields: never ticked, and unticked when the site ticked it.
  const anchor = password ?? username ?? codeField ?? codeBoxes[0];
  let rememberDevice = false;
  if (anchor)
    for (const box of all(
      "input[type=checkbox], [role=checkbox]",
      near(anchor),
    )) {
      const text =
        box instanceof HTMLInputElement
          ? `${describe(box)} ${textOf(box.parentElement).slice(0, 160)}`
          : `${box.getAttribute("aria-label") ?? ""} ${textOf(box)} ${textOf(box.parentElement).slice(0, 160)}`;
      if (!words.remember.test(text)) continue;
      rememberDevice = true;
      const ticked =
        box instanceof HTMLInputElement
          ? box.checked
          : box.getAttribute("aria-checked") === "true";
      if (ticked && options.uncheckRemember) (box as HTMLElement).click();
    }

  // The page's message: an alert or error-styled element first, else error words near the form.
  const ALERTS = [
    "[role=alert]",
    "[aria-live=assertive]",
    "[aria-live=polite]",
    ".invalid-feedback",
    ".alert-danger",
    '[class*="error" i]',
    '[id*="error" i]',
  ].join(", ");
  const alerts = all(ALERTS)
    .filter(
      (element) =>
        shown(element) && !element.querySelector("input, select, textarea"),
    )
    .map((element) => tidy((element as HTMLElement).innerText))
    .filter((text) => text.length >= 2 && text.length <= 300);
  for (const field of all("[aria-invalid=true]")) {
    const root = field.getRootNode() as Document | ShadowRoot;
    const ids = `${field.getAttribute("aria-errormessage") ?? ""} ${field.getAttribute("aria-describedby") ?? ""}`;
    for (const id of ids.split(/\s+/).filter(Boolean)) {
      const text = textOf(root.getElementById(id));
      if (text.length >= 2 && text.length <= 300) alerts.push(text);
    }
  }
  const worded = (root: Node): string | undefined => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = tidy(node.textContent);
      const parent = node.parentElement;
      if (
        !parent ||
        text.length < 2 ||
        text.length > 200 ||
        !words.error.test(text) ||
        parent.closest(
          "script, style, noscript, template, title, label, a, button, option",
        ) ||
        !shown(parent)
      )
        continue;
      return tidy(parent.innerText || text).slice(0, 300);
    }
    return undefined;
  };
  const errorAlert = alerts.find((text) => words.error.test(text));
  const nearby = anchor ? near(anchor) : undefined;
  const nearbyRoot =
    nearby instanceof Element ? (nearby.parentElement ?? nearby) : nearby;
  const wordedMessage =
    errorAlert === undefined
      ? ((nearbyRoot ? worded(nearbyRoot) : undefined) ??
        [...roots].map((root) => worded(root)).find(Boolean))
      : undefined;
  const message = errorAlert ?? wordedMessage ?? alerts[0];

  const bodyText = tidy(document.body?.innerText).slice(0, 20_000);
  const result: PageScan = {
    username: Boolean(username),
    password: Boolean(password),
    code: Boolean(codeField) || codeBoxes.length > 0,
    codeBoxes: codeBoxes.map((box) => box.maxLength),
    rememberDevice,
    ...(message ? { message } : {}),
    messageIsError: Boolean(message && words.error.test(message)),
    messageFromAlert: Boolean(errorAlert ?? (!wordedMessage && alerts[0])),
    approval: words.approval.test(bodyText.slice(0, 5_000)),
  };
  if (!options.challenge) return result;

  // The same signals challenge.ts reads, so its classifier can be asked.
  const visibleInView = (element: Element) => {
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
  const widgets = [...document.querySelectorAll("iframe[src]")].filter(
    (frame) => {
      const src = frame.getAttribute("src") ?? "";
      return (
        /(?:google\.com\/recaptcha|recaptcha\.net\/recaptcha|hcaptcha\.com\/|challenges\.cloudflare\.com\/)/i.test(
          src,
        ) && visibleInView(frame)
      );
    },
  );
  const controls = [
    ...document.querySelectorAll(
      'input[type="checkbox"], [role="checkbox"], button',
    ),
  ];
  return {
    ...result,
    challengeText: bodyText,
    challengeControl:
      widgets.length > 0 ||
      controls.some(
        (control) =>
          visibleInView(control) &&
          /human|not a robot|verify|captcha/i.test(
            control.getAttribute("aria-label") ??
              control.closest("label")?.textContent ??
              control.textContent ??
              "",
          ),
      ),
    challengeWidget: widgets.some(
      (frame) => !/size=invisible/.test(frame.getAttribute("src") ?? ""),
    ),
  };
}

/**
 * How a form is sent, decided in the page: its own submit button when it has one, the form itself
 * when it has none (a form with several fields and no button ignores Enter), and Enter otherwise.
 *
 * A login no form wraps is sent by a script on its button, and Enter in a field goes nowhere: the
 * login was typed, nothing sent it, and the person was told it "was probably not accepted". So with no
 * form, the button is found the way a person finds it: the nearest one around the field that says it
 * sends the login, never one that shows the password, resends a code or signs in somewhere else. The
 * walk goes up through shadow roots to their hosts. Enter only when there is no such button.
 * Self-contained, because it runs in the page.
 */
function markSubmit(
  field: Element,
  options: { attribute: string; sends: string; elsewhere: string },
): "button" | "form" | "key" {
  const { attribute } = options;
  const sends = new RegExp(options.sends, "i");
  const elsewhere = new RegExp(options.elsewhere, "i");
  const label = (element: Element) =>
    [
      element.textContent,
      (element as HTMLInputElement).value,
      element.id,
      element.getAttribute("name"),
      element.getAttribute("aria-label"),
    ]
      .filter(Boolean)
      .join(" ");
  const form = (field as HTMLInputElement).form;
  if (form) {
    const button = [
      ...form.querySelectorAll(
        "button:not([type=button]):not([type=reset]), input[type=submit]",
      ),
    ].find((element) => !elsewhere.test(label(element)));
    if (button) {
      button.setAttribute(attribute, "submit");
      return "button";
    }
    return "form";
  }
  const usable = (element: Element) => {
    const box = element.getBoundingClientRect();
    return (
      box.width > 0 &&
      box.height > 0 &&
      !(element as HTMLButtonElement).disabled &&
      !elsewhere.test(label(element))
    );
  };
  const up = (node: ParentNode): ParentNode | null => {
    const element = node instanceof ShadowRoot ? node.host : (node as Element);
    if (element.parentElement) return element.parentElement;
    const root = element.getRootNode();
    return root instanceof ShadowRoot && root !== node ? root : null;
  };
  let scope = up(field);
  for (let depth = 0; scope && depth < 7; depth++) {
    const candidates = [
      ...scope.querySelectorAll(
        "button, input[type=submit], input[type=button], [role=button]",
      ),
    ].filter(usable);
    const chosen =
      candidates.find(
        (element) =>
          element.getAttribute("type") === "submit" &&
          element.tagName === "INPUT",
      ) ?? candidates.find((element) => sends.test(label(element)));
    if (chosen) {
      chosen.setAttribute(attribute, "submit");
      return "button";
    }
    scope = up(scope);
  }
  return "key";
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const marked = (frame: Frame, name: string) =>
  frame.locator(`[${LOGIN_ATTRIBUTE}="${name}"]`);

async function submitFrom(frame: Frame, field: Locator) {
  const how = await field.evaluate(markSubmit, {
    attribute: LOGIN_ATTRIBUTE,
    sends: SIGN_IN_WORDS.sends,
    elsewhere: SIGN_IN_WORDS.elsewhere,
  });
  if (how === "button")
    await marked(frame, "submit").click({ timeout: STEP_TIMEOUT_MS });
  else if (how === "form")
    await field.evaluate((element) =>
      (element as HTMLInputElement).form?.requestSubmit(),
    );
  else await field.press("Enter", { timeout: STEP_TIMEOUT_MS });
}

/** Let a submit land. Never throws: the page may close under it (a popup handing back). */
async function settle(page: Page) {
  if (page.isClosed()) return;
  await sleep(800);
  await page
    .waitForLoadState("load", { timeout: STEP_TIMEOUT_MS })
    .catch(() => undefined);
  await page
    .waitForLoadState("networkidle", { timeout: 5_000 })
    .catch(() => undefined);
}

/**
 * The page to read after a submit.
 *
 * A window the submit opened, newest first. Else the same page while it is open. Else, for a sign-in
 * window that closed itself after the login (an OAuth popup handing back), the window that opened it,
 * and failing that the newest page still open, the one the Bot is now driving.
 */
function pageAfter(
  page: Page,
  opener: Page | null,
  before: ReadonlySet<Page>,
): Page {
  const pages = page.context().pages();
  const opened = chooseLivePage(pages.filter((other) => !before.has(other)));
  if (opened) return opened;
  if (!page.isClosed()) return page;
  if (opener && !opener.isClosed()) return opener;
  return chooseLivePage(pages) ?? page;
}

/** Run a submit, and follow it to the page that answers it. */
async function send(
  page: Page,
  opener: Page | null,
  submit: () => Promise<void>,
  landed: () => Promise<boolean> = async () => false,
): Promise<Page> {
  const before = new Set(page.context().pages());
  try {
    await submit();
  } catch (error) {
    // A window that closed on its own submit, or a form the page already sent itself (a code that
    // submits on its last box), went; anything else is a failure.
    if (!page.isClosed() && !(await landed().catch(() => false))) throw error;
  }
  await settle(page);
  const next = pageAfter(page, opener, before);
  if (next !== page) await settle(next);
  return next;
}

type FrameScan = { frame: Frame; scan: PageScan };

/** Every frame of the page read, the main frame first. Frames that cannot be read are skipped. */
async function scanFrames(
  page: Page,
  options: { uncheckRemember?: boolean; challenge?: boolean } = {},
): Promise<FrameScan[]> {
  if (page.isClosed()) return [];
  const main = page.mainFrame();
  const scans: FrameScan[] = [];
  for (const frame of [main, ...page.frames().filter((f) => f !== main)]) {
    try {
      scans.push({
        frame,
        scan: await frame.evaluate(scanPage, {
          attribute: LOGIN_ATTRIBUTE,
          words: SIGN_IN_WORDS,
          uncheckRemember: options.uncheckRemember ?? false,
          challenge: (options.challenge ?? false) && frame === main,
          around: false,
        }),
      });
    } catch {
      // A frame mid-navigation or detached: not this one.
    }
  }
  return scans;
}

/** The whole page, every frame together. */
export type SignInPageSummary = {
  username: boolean;
  password: boolean;
  code: boolean;
  message?: string;
  messageIsError: boolean;
  messageFromAlert: boolean;
  approval: boolean;
  captcha: boolean;
  rememberDevice: boolean;
};

function summarise(scans: FrameScan[]): SignInPageSummary {
  const main = scans[0]?.scan;
  const withMessage = scans.find(({ scan }) => scan.message)?.scan;
  return {
    username: scans.some(({ scan }) => scan.username),
    password: scans.some(({ scan }) => scan.password),
    code: scans.some(({ scan }) => scan.code),
    ...(withMessage?.message ? { message: withMessage.message } : {}),
    messageIsError: withMessage?.messageIsError ?? false,
    messageFromAlert: withMessage?.messageFromAlert ?? false,
    approval: scans.some(({ scan }) => scan.approval),
    captcha: Boolean(
      main &&
        (main.challengeWidget ||
          classifyChallenge({
            text: main.challengeText ?? "",
            visibleChallengeControl: main.challengeControl ?? false,
          })),
    ),
    rememberDevice: scans.some(({ scan }) => scan.rememberDevice),
  };
}

/**
 * How the page answered what was just sent: a login, a username step, or a code.
 *
 * In order: a security check only a person can pass; a code box still asking after a code (the code
 * was refused, whether or not the site says so); an error, in words, on a form that is still showing
 * or anywhere after a code (a wrong code is never reported as signed in);
 * a code now asked for; an approval waited for on the person's phone; a password field still showing
 * (the login was refused, quoting whatever the page said); an alert that says something went wrong;
 * and otherwise signed in. A message without error words beside a new code box ("we sent a code to
 * your phone") is the code being asked for, not a failure. Pure, so it is tested without a browser.
 */
export function classifySignInPage(
  page: SignInPageSummary,
  sent: "username" | "login" | "code",
): SignInCheck {
  const quoted = page.message
    ? { pageMessage: page.message.slice(0, 200) }
    : {};
  const onForm = page.password || page.code || page.username;
  const refused = Boolean(page.message && page.messageIsError);
  if (page.captcha) return { outcome: "captcha" };
  if (sent === "code" && page.code) return { outcome: "error", ...quoted };
  if ((onForm || sent === "code") && refused)
    return { outcome: "error", ...quoted };
  if (page.code) return { outcome: "code-requested" };
  if (page.approval) return { outcome: "push-approval" };
  if (page.password || (sent === "username" && page.username))
    return { outcome: "error", ...quoted };
  if (refused && page.messageFromAlert) return { outcome: "error", ...quoted };
  return { outcome: "signed-in" };
}

/**
 * The page's icon, small, as a data URL, fetched by the Bot's own browser (so through its own egress
 * and never by the server). Anything that is not a small image is no icon. Remembered per address, so
 * a page read again and again (waiting on an approval) is not fetched each time.
 */
const icons = new Map<string, string | undefined>();

async function pageIcon(page: Page): Promise<string | undefined> {
  try {
    const href = await page.evaluate(() => {
      const link = document.querySelector<HTMLLinkElement>(
        'link[rel~="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]',
      );
      return link?.href || new URL("/favicon.ico", location.origin).href;
    });
    if (!/^https?:/.test(href)) return undefined;
    if (icons.has(href)) return icons.get(href);
    const icon = await fetchIcon(page, href);
    if (icons.size >= 64) icons.delete(icons.keys().next().value ?? "");
    icons.set(href, icon);
    return icon;
  } catch {
    return undefined;
  }
}

async function fetchIcon(page: Page, href: string) {
  const response = await page.request.get(href, {
    timeout: 4_000,
    maxRedirects: 3,
  });
  if (!response.ok()) return undefined;
  const type =
    (response.headers()["content-type"] ?? "").split(";")[0]?.trim() ?? "";
  if (
    !/^image\/(png|x-icon|vnd\.microsoft\.icon|svg\+xml|jpeg|gif|webp)$/.test(
      type,
    )
  )
    return undefined;
  const body = await response.body();
  if (body.length === 0 || body.length > 32_768) return undefined;
  return `data:${type};base64,${body.toString("base64")}`;
}

/** What the Bot's page asks for right now. Reads and marks fields; types nothing. */
export async function probeSignIn(page: Page): Promise<SignInProbe> {
  const url = page.url();
  const origin = originOfUrl(url);
  let host = "";
  try {
    host = origin ? new URL(origin).host : "";
  } catch {
    host = "";
  }
  const scans = await scanFrames(page, { challenge: true });
  const login = scans.find(({ scan }) => scan.password || scan.username);
  const form: SignInProbe["form"] = login
    ? login.scan.password
      ? "login"
      : "username"
    : scans.some(({ scan }) => scan.code)
      ? "code"
      : "none";
  const check = classifySignInPage(summarise(scans), "login");
  const icon = origin ? await pageIcon(page) : undefined;
  return { url, origin, host, form, check, ...(icon ? { icon } : {}) };
}

async function typeSecret(field: Locator, value: string) {
  // Marked first as well as after, so not one frame of the live screen shows it unmasked.
  await field.evaluate(markElementSecret, SECRET_ATTRIBUTE).catch(() => {});
  await field.fill(value, { timeout: STEP_TIMEOUT_MS });
  await field.evaluate(markElementSecret, SECRET_ATTRIBUTE);
}

/**
 * A code typed into a row of boxes, one box at a time, the way a person types it.
 *
 * Each box is emptied and typed with real key presses, so a site that moves the focus on its own
 * still ends with every box holding its own character. A value that does not fit the boxes (spaces
 * or dashes aside) goes into the first box whole, as a paste would, for the site's script to spread.
 */
async function typeIntoBoxes(
  frame: Frame,
  lengths: number[],
  value: string,
  timeout: number,
) {
  const box = (index: number) => marked(frame, `code-${index}`);
  for (const index of lengths.keys())
    await box(index)
      .evaluate(markElementSecret, SECRET_ATTRIBUTE)
      .catch(() => {});
  const compact = value.replace(/[\s-]/g, "");
  const total = lengths.reduce((sum, length) => sum + length, 0);
  if (compact.length !== total) {
    await box(0).fill("", { timeout });
    await box(0).pressSequentially(value, { timeout });
    return;
  }
  let offset = 0;
  for (const [index, length] of lengths.entries()) {
    const part = compact.slice(offset, offset + length);
    offset += length;
    // A site that submits on its last box may already be gone.
    if (index > 0 && (await box(index).count()) === 0) return;
    await box(index).fill("", { timeout });
    await box(index).pressSequentially(part, { timeout });
  }
}

/** Type a code into whatever the scan found: one field, or a row of boxes. */
async function typeCode(found: FrameScan, code: string) {
  if (found.scan.codeBoxes.length > 1)
    await typeIntoBoxes(
      found.frame,
      found.scan.codeBoxes,
      code,
      STEP_TIMEOUT_MS,
    );
  else await typeSecret(marked(found.frame, "code"), code);
}

function codeField(found: FrameScan) {
  return marked(
    found.frame,
    found.scan.codeBoxes.length > 1
      ? `code-${found.scan.codeBoxes.length - 1}`
      : "code",
  );
}

/**
 * One value a person supplied for a field the Bot named (`/human/secret`), typed into it.
 *
 * When the field is one box of a row that takes a code a character at a time, the value is spread
 * over the row; otherwise it is typed into the field. Either way the field is marked secret. Throws
 * when the field cannot be typed into, so a value is never reported delivered that no field received.
 */
export async function typeSecretValue(
  page: Page,
  field: Locator,
  value: string,
  timeout: number,
) {
  const around = `${LOGIN_ATTRIBUTE}-around`;
  const flagged = await field
    .evaluate((element, name) => {
      element.setAttribute(name, "");
      return true;
    }, around)
    .catch(() => false);
  if (flagged)
    for (const frame of page.frames()) {
      let scan: PageScan;
      try {
        if ((await frame.locator(`[${around}]`).count()) === 0) continue;
        scan = await frame.evaluate(scanPage, {
          attribute: LOGIN_ATTRIBUTE,
          words: SIGN_IN_WORDS,
          uncheckRemember: false,
          challenge: false,
          around: true,
        });
      } catch {
        continue;
      }
      if (scan.codeBoxes.length > 1) {
        await typeIntoBoxes(frame, scan.codeBoxes, value, timeout);
        return;
      }
      break;
    }
  await field.fill(value, { timeout });
  await field.evaluate(markElementSecret, SECRET_ATTRIBUTE).catch(() => {});
}

/** The origin of a URL, or empty for one that has none (`about:blank`). */
export function originOfUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.origin
      : "";
  } catch {
    return "";
  }
}

/** Parse the body the server sends, without ever putting a value in an error. */
export function parseSignInFill(body: unknown): SignInFillInput | string {
  if (!body || typeof body !== "object") return "A sign-in needs a JSON body.";
  const input = body as Record<string, unknown>;
  if (typeof input.origin !== "string" || !originOfUrl(input.origin))
    return "A sign-in names the website's origin.";
  if (input.password !== undefined && typeof input.password !== "string")
    return "The password must be text.";
  if (input.username !== undefined && typeof input.username !== "string")
    return "The username must be text.";
  if (input.code !== undefined && typeof input.code !== "string")
    return "The code must be text.";
  if (!input.password && !input.code)
    return "A sign-in needs a password, or a code for a page that asks for one alone.";
  return {
    origin: originOfUrl(input.origin),
    ...(input.password ? { password: input.password } : {}),
    ...(input.username ? { username: input.username } : {}),
    ...(input.code ? { code: input.code } : {}),
  };
}

/**
 * After a username step: wait, in every frame of whichever page now answers, for the password field,
 * or for the page to answer some other way (a code, an approval on the phone, a security check, an
 * error that was not there before). Nothing new by the deadline is no answer.
 */
async function afterUsername(
  page: Page,
  opener: Page | null,
  before: ReadonlySet<Page>,
  earlierMessage: string | undefined,
): Promise<{ page: Page; login?: FrameScan; check?: SignInCheck }> {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  let live = page;
  for (;;) {
    live = pageAfter(live, opener, before);
    const scans = await scanFrames(live, {
      uncheckRemember: true,
      challenge: true,
    });
    const login = scans.find(({ scan }) => scan.password);
    if (login) return { page: live, login };
    const summary = summarise(scans);
    const fresh =
      summary.message !== undefined && summary.message !== earlierMessage;
    if (
      summary.code ||
      summary.approval ||
      summary.captcha ||
      (fresh && summary.messageIsError)
    )
      return { page: live, check: classifySignInPage(summary, "username") };
    if (Date.now() > deadline) {
      const answered = fresh && summary.messageFromAlert && summary.username;
      return answered
        ? { page: live, check: classifySignInPage(summary, "username") }
        : { page: live };
    }
    await sleep(300);
  }
}

export async function fillSignIn(
  page: Page,
  input: SignInFillInput,
): Promise<SignInFillResult> {
  let live = page;
  const answer = (error: string, submitted = false): SignInFillResult => ({
    submitted,
    passwordFieldVisible: false,
    url: live.url(),
    error,
  });
  if (originOfUrl(page.url()) !== input.origin)
    return answer(
      `The Bot's browser is not on ${input.origin}. Ask it to open that site's sign-in page and try again.`,
    );
  const opener = await page.opener().catch(() => null);
  let remembered = false;
  const answered = (
    summary: SignInPageSummary,
    check: SignInCheck,
  ): SignInFillResult => ({
    submitted: true,
    passwordFieldVisible: summary.password,
    url: live.url(),
    outcome: check.outcome,
    ...(check.pageMessage ? { pageMessage: check.pageMessage } : {}),
    ...(remembered ? { rememberDeviceLeftUnchecked: true } : {}),
  });
  const readAnswer = async (sent: "username" | "login" | "code") => {
    const summary = summarise(await scanFrames(live, { challenge: true }));
    return { summary, check: classifySignInPage(summary, sent) };
  };
  const codeGone = (found: FrameScan) => async () =>
    (await codeField(found).count()) === 0;
  try {
    if (!input.password) {
      // A one-time code on a page of its own, sent after the login (an SMS confirmation, say).
      const found = (await scanFrames(live, { uncheckRemember: true })).find(
        ({ scan }) => scan.code,
      );
      if (!found)
        return answer("There is no code field on the page the Bot has open.");
      remembered = found.scan.rememberDevice;
      await typeCode(found, input.code ?? "");
      live = await send(
        live,
        opener,
        async () => {
          if (await codeGone(found)()) return;
          await submitFrom(found.frame, codeField(found));
        },
        codeGone(found),
      );
      const { summary, check } = await readAnswer("code");
      return answered(summary, check);
    }
    const first = await scanFrames(live, { uncheckRemember: true });
    let login = first.find(({ scan }) => scan.password || scan.username);
    if (!login)
      return answer("There is no sign-in form on the page the Bot has open.");
    remembered = login.scan.rememberDevice;
    // Masked like the password: "never shown to your Bot" covers the username too, and a username
    // field is not a type the snapshot hides on its own.
    if (login.scan.username && input.username)
      await typeSecret(marked(login.frame, "username"), input.username);
    if (!login.scan.password) {
      // Two steps: username first, then the site shows the password field, here or elsewhere.
      if (!input.username)
        return answer(
          "This site asks for a username first. Enter one and try again.",
        );
      const step = login;
      const before = new Set(live.context().pages());
      try {
        await submitFrom(step.frame, marked(step.frame, "username"));
      } catch (error) {
        if (!live.isClosed()) throw error;
      }
      const next = await afterUsername(
        live,
        opener,
        before,
        summarise(first).message,
      );
      live = next.page;
      if (next.check) {
        const summary = summarise(await scanFrames(live));
        return answered(summary, next.check);
      }
      if (!next.login)
        return answer(
          "The site did not ask for a password after the username.",
          true,
        );
      const now = originOfUrl(live.url());
      if (now !== input.origin) {
        if (!now)
          return answer(
            "The sign-in moved to another page. Take over the browser to finish signing in there.",
            true,
          );
        return {
          submitted: true,
          passwordFieldVisible: true,
          url: live.url(),
          movedTo: { origin: now, form: "login" },
          ...(remembered ? { rememberDeviceLeftUnchecked: true } : {}),
        };
      }
      login = next.login;
      remembered ||= login.scan.rememberDevice;
    }
    const { frame } = login;
    await typeSecret(marked(frame, "password"), input.password);
    // A code box on the same form as the password takes the code before it is sent.
    const codeHere = Boolean(input.code && login.scan.code);
    if (codeHere && input.code) await typeCode(login, input.code);
    live = await send(live, opener, () =>
      submitFrom(frame, marked(frame, "password")),
    );
    let { summary, check } = await readAnswer(codeHere ? "code" : "login");
    if (input.code && !codeHere && check.outcome === "signed-in") {
      // A code page that is slow to draw: look once more before calling it signed in.
      await sleep(2_000);
      ({ summary, check } = await readAnswer("login"));
    }
    if (input.code && !codeHere && check.outcome === "code-requested") {
      const now = originOfUrl(live.url());
      if (now !== input.origin) {
        if (!now)
          return answer(
            "The sign-in moved to another page before the code was asked for. Take over the browser to finish.",
            true,
          );
        return {
          submitted: true,
          passwordFieldVisible: summary.password,
          url: live.url(),
          movedTo: { origin: now, form: "code" },
          ...(remembered ? { rememberDeviceLeftUnchecked: true } : {}),
        };
      }
      const found = (await scanFrames(live, { uncheckRemember: true })).find(
        ({ scan }) => scan.code,
      );
      if (found) {
        remembered ||= found.scan.rememberDevice;
        await typeCode(found, input.code);
        live = await send(
          live,
          opener,
          async () => {
            if (await codeGone(found)()) return;
            await submitFrom(found.frame, codeField(found));
          },
          codeGone(found),
        );
        ({ summary, check } = await readAnswer("code"));
      }
    }
    return answered(summary, check);
  } catch {
    return answer("The login could not be typed into the page.");
  }
}
