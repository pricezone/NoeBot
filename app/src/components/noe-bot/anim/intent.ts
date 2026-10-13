/**
 * What the person asks → the sequence the reply will follow (avatar-map.json §intentRules), and
 * how they said it → the face that greets it (§sentimentReactions).
 *
 * Keyword rules, English and Greek, seeded from the design's own examples. They only bridge the
 * first seconds before a tool signal arrives, so a miss costs a face, never the work.
 */

import type { AnimationId } from "./catalog";

export type Intent = {
  id: string;
  sequence: readonly AnimationId[];
};

type IntentRule = Intent & { test: RegExp };

const RULES: readonly IntentRule[] = [
  {
    id: "gratitude / affection",
    test: /\b(thanks?|thank you|thx|ty|love (it|you|this)|awesome|brilliant|perfect|great job|well done)\b|ευχαριστ|σ'? ?αγαπ|τέλει[οα]|μπράβο|υπέροχ|φανταστικ|❤|😍|🙏/i,
    sequence: ["face:in-love", "action:heart"],
  },
  {
    id: "greeting / small talk",
    test: /^\s*(hi|hello|hey|yo|good (morning|evening|afternoon|night)|gm|howdy|sup|what's up|γεια|γεια σου|γεια σας|καλημέρα|καλησπέρα|καληνύχτα|χαίρετε|έλα)(?=[\s!.,;?]|$)[\s!.,;?]*$/i,
    sequence: ["face:happy", "action:greeting"],
  },
  {
    id: "secret / private info",
    test: /\b(between us|secret|confidential|don't tell|private)\b|μεταξύ μας|μυστικ|εμπιστευτικ|μην το πεις/i,
    sequence: ["face:shush"],
  },
  {
    id: "debug",
    test: /\b(why (does|is|did)|crash|error|exception|bug|broken|doesn't work|not working|fails?|failing|stack ?trace|fix (this|the|it))\b|γιατί (σκάει|δεν|κρασάρει)|σφάλμα|λάθος|δεν δουλεύει|δεν λειτουργεί|χαλασμέν|διόρθωσ|φτιάξ(ε|το) (το|αυτό)/i,
    sequence: ["face:suspicious", "action:search", "state:repair"],
  },
  {
    // An address or a task on a site: the Bot is about to browse, never to write code. Before
    // "build UI" and "code task", whose words ("page", "code") a browser task often carries.
    id: "browse the web",
    test: /https?:\/\/|\bwww\.|\b[a-z0-9-]+\.(com|gr|org|net|io|eu|gov|edu|app|ai|dev|co|uk|de)\b|\b(go to|visit|browse|navigate to|fill (in|out)|log ?in to|sign ?in to|sign me up)\b|\bopen (the |this |that )?(site|website|page|link|url|portal)\b|\bon (the|their|this) (site|website|portal)\b|μπες (σ|στ)|πήγαινε (σ|στ)|άνοιξε (το|τη|την) (σελίδα|site|link|σύνδεσμο|ιστοσελίδα)|συνδέσου|συμπλήρωσ|φόρμα|ιστότοπ/i,
    sequence: ["face:curious", "action:search", "face:nerd"],
  },
  {
    id: "deploy / infra",
    test: /\b(deploy|production|prod|release|ship it|server|database|db|migration|docker|kubernetes|dns|domain|hosting)\b|ανέβασ|παραγωγ|διακομιστ|βάση δεδομένων|εγκατ[άα]στ/i,
    sequence: ["face:attentive", "state:servers"],
  },
  {
    id: "run / test",
    test: /\b(run|execute|exec|test|tests|try it|start)\b|τρέξ(ε|το)|εκτέλεσ|δοκίμασ|τεστ/i,
    sequence: ["action:terminal"],
  },
  {
    id: "build UI",
    test: /\b(landing page|web ?page|website|ui|interface|dashboard|slide|deck|presentation|mockup|design)\b|σελίδα|ιστοσελίδ|παρουσίασ|διεπαφ|σχεδίασ/i,
    sequence: ["face:excited", "action:present"],
  },
  {
    id: "code task",
    test: /\b(code|function|class|component|refactor|implement|script|typescript|javascript|python|sql|regex|api|endpoint|write .* (function|script|code))\b|κώδικ|συνάρτηση|υλοποίησ|προγραμμ/i,
    sequence: ["face:curious", "action:type"],
  },
  {
    id: "data / analytics",
    test: /\b(analy[sz]e|analysis|csv|spreadsheet|logs?|metrics|numbers|statistics|stats|report|chart|audit)\b|ανάλυσ|αναλυσ|δεδομέν|στατιστικ|αναφορ|μετρικ/i,
    sequence: ["face:nerd", "action:logs"],
  },
  {
    id: "finance",
    test: /\b(budget|invoice|price|pricing|cost|quote|payment|salary|tax|vat|profit|revenue|expense)\b|προϋπολογισμ|τιμολόγ|τιμή|κόστος|πληρωμ|φόρο|φπα|έσοδ|έξοδ/i,
    sequence: ["face:monocle", "action:cash"],
  },
  {
    id: "music / audio",
    test: /\b(playlist|song|music|audio|podcast|transcri(be|pt)|record(ing)?|voice|sound)\b|μουσικ|τραγούδ|ήχο|απομαγνητοφών|ηχογράφ/i,
    sequence: ["action:music"],
  },
  {
    id: "games / fun",
    test: /\b(play|game|joke|riddle|quiz|fun|trivia)\b|παίξ|παιχνίδ|αστείο|ανέκδοτο|κουίζ|γρίφο/i,
    sequence: ["face:zany", "action:game"],
  },
  {
    id: "fitness / motivation",
    test: /\b(workout|exercise|gym|motivat|fitness|training plan|diet|run(ning)? plan)\b|γυμναστ|προπόνησ|άσκησ|κίνητρο|δίαιτα/i,
    sequence: ["action:flex", "action:barbell"],
  },
  {
    id: "travel / plans / moving",
    test: /\b(trip|travel|itinerary|flight|hotel|vacation|holiday|move house|moving|route|directions)\b|ταξίδ|εκδρομ|πτήσ|ξενοδοχ|διακοπ|μετακόμισ|διαδρομ/i,
    sequence: ["action:walk", "action:skate"],
  },
  {
    id: "creative / imagine",
    test: /\b(poem|story|brainstorm|ideas?|names? for|slogan|imagine|creative|lyrics|haiku)\b|ποίημα|ιστορία|ιδέες|ονόματα|σλόγκαν|φαντάσου|δημιουργικ|στίχ/i,
    sequence: ["face:star-struck", "action:sparkler"],
  },
  {
    id: "big multi-step task",
    test: /\b(plan and build|whole feature|end to end|everything|all of it|from scratch|entire|complete project|step by step)\b|ολόκληρ|απ'? ?την αρχή|από την αρχή|όλο το|βήμα βήμα/i,
    sequence: ["face:proud", "state:sub-agents", "state:powered-up"],
  },
  {
    id: "long-running / heavy",
    test: /\b(\d{2,}[,.]?\d*k?|thousand|million)\s+(rows|records|files|items|pages|emails)\b|process all|batch|χιλιάδες|εκατομμύρι|όλα τα αρχεία|μαζικ/i,
    sequence: ["action:coffee", "state:caffeinated"],
  },
  {
    id: "summarise / explain a document",
    test: /\b(summari[sz]e|summary|tl;?dr|explain|what does .* (say|mean)|key points|recap)\b.*|\b(this|the|attached) (pdf|document|doc|file|article|paper|email|thread)\b|περίληψ|συνόψισ|εξήγησ|τι λέει|κύρια σημεία/i,
    sequence: ["face:attentive", "action:study", "action:writing"],
  },
  {
    id: "write text",
    test: /\b(write|draft|compose|reply to|respond to|email|letter|post|tweet|message|caption|bio|cover letter|essay|blog)\b|γράψ(ε|ου)|σύνταξ|απάντησ|μήνυμα|ανάρτησ|άρθρο|κείμενο|επιστολ/i,
    sequence: ["face:attentive", "action:writing"],
  },
  {
    id: "question needing research",
    test: /\b(what('s| is) the latest|latest|news|compare|vs\.?|versus|difference between|research|look up|find out|who is|what is|when did|how much|best .* for)\b|\?\s*$|σύγκριν|διαφορ|ψάξ|βρες|ποιος είναι|τι είναι|πότε|πόσο|τελευταί|νέα για|έρευν|;\s*$/i,
    sequence: ["face:curious", "action:search", "action:study"],
  },
];

/** The intent a message reads as, or null when nothing in it matches. */
export const classifyIntent = (text: string): Intent | null => {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const rule = RULES.find((r) => r.test.test(trimmed));
  return rule ? { id: rule.id, sequence: rule.sequence } : null;
};

export type Tone =
  | "happy"
  | "grateful"
  | "joking"
  | "frustrated"
  | "sad"
  | "urgent"
  | "confused"
  | "neutral";

const TONES: readonly { tone: Tone; face: string; test: RegExp }[] = [
  {
    tone: "grateful",
    face: "in-love",
    test: /\b(thanks?|thank you|thx|grateful|appreciate)\b|ευχαριστ|🙏/i,
  },
  {
    tone: "frustrated",
    face: "worried",
    test: /\b(wtf|damn|ugh|frustrat|annoy|angry|furious|ridiculous|again\?+|still (broken|not))\b|[!]{2,}|γαμώ|νεύρα|εκνευρ|απαράδεκτ|πάλι;|ξανά;|😡|🤬/i,
  },
  {
    tone: "urgent",
    face: "surprised",
    test: /\b(urgent|asap|right now|immediately|quick|hurry|emergency|deadline)\b|επείγ|αμέσως|τώρα αμέσως|γρήγορα|προθεσμ|🚨/i,
  },
  {
    tone: "sad",
    face: "pleading",
    test: /\b(sad|depress|unhappy|lonely|miss (him|her|them)|lost|sorry)\b|λυπ|στενοχωρ|μόνος|χάσαμε|συγγνώμη|😢|😭/i,
  },
  {
    tone: "joking",
    face: "laughing",
    test: /\b(lol|haha|lmao|rofl|joke|kidding|funny)\b|χαχα|αστει|πλάκα|😂|🤣/i,
  },
  {
    tone: "happy",
    face: "excited",
    test: /\b(yay|awesome|amazing|great|love|excited|wonderful|woohoo|let's go)\b|τέλει|υπέροχ|φοβερ|ανυπομον|😄|🎉|😍/i,
  },
  {
    tone: "confused",
    face: "curious",
    test: /\b(confus|don't (get|understand)|not sure|what do you mean|huh|\?\?)\b|μπερδε|δεν καταλαβαίν|δεν είμαι σίγουρ|τι εννοείς|;;/i,
  },
];

/** The face that greets a message: how the person sounds, read from the words alone. */
export const reactionFor = (
  text: string,
): { tone: Tone; face: AnimationId } => {
  const hit = TONES.find((t) => t.test.test(text));
  return hit
    ? { tone: hit.tone, face: `face:${hit.face}` }
    : { tone: "neutral", face: "face:attentive" };
};

/** Greek script anywhere in the message means Greek labels. */
export const languageOf = (text: string | null | undefined): "en" | "el" =>
  text && /[Ͱ-Ͽ]/.test(text) ? "el" : "en";
