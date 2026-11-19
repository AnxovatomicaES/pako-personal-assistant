// Plain words for the read-only views (src/whatsapp.ts answers them as it answers their commands): "what am I forgetting", "what's on
// today?", "my agenda tomorrow", "anything on Slack?", "my reminders", "what came out of my meetings?".
//
// Only a clear match counts: the whole message has to be one of these questions, with at most a greeting, "tell me", "please" or "Pako"
// around it. Anything longer or different ("remind me tomorrow to check what's pending", "what came out of the meeting with Ana?") goes to
// Claude as before, which has the same views in its context (src/whatsapp.ts /assistant/context). Capitals, punctuation and emoji do not
// count, and a small typo in a long word is forgiven ("remidners", "tomorow", "agneda"); a short word must be right.
//
// English only, like every fixed word of Pako's: the same question in another language goes to Claude, which answers it in that language
// from the same context.
//
// Two more read the same way: "is everything working?" opens HEALTH (src/watchdog.ts: each part, plus src/quality.ts's week), and "do a dry
// run" starts REHEARSAL (src/rehearsal.ts: a dry run on the last 48 h, nothing sent).

/** A view the door answers by itself. `agenda` is today and tomorrow; the others are one day. */
export type View =
  | "followups" | "agenda" | "agenda-today" | "agenda-tomorrow" | "brief" | "slack" | "reminders" | "meeting-todos" | "health" | "rehearsal";

/** The command each view is: what src/whatsapp.ts already answers. */
export const VIEW_COMMAND: Record<View, string> = {
  followups: "pending",
  agenda: "agenda",
  "agenda-today": "agenda today",
  "agenda-tomorrow": "agenda tomorrow",
  brief: "brief",
  slack: "slack",
  reminders: "reminders",
  "meeting-todos": "meeting todos",
  health: "health",
  rehearsal: "rehearsal",
};

/** Longer than this (in characters, before clean-up) is a request, not a question for a view. */
const MAX_CHARS = 90;

/** The message as a command is read: no accents, lower case, punctuation, symbols and emoji gone, one space between words. */
export function plainWords(text: string): string {
  return text.normalize("NFKC").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/[\p{P}\p{S}\p{Cf}\p{Cc}\s]+/gu, " ").trim();
}

/** Shorthands written for whole words. */
const SHORT: Record<string, string> = {
  whats: "what s", wats: "what s", im: "i m", tmrw: "tomorrow", tmr: "tomorrow", tomoz: "tomorrow", pls: "please", plz: "please", u: "you",
};

/** The long words a typo is forgiven in (one letter wrong, missing, extra or two swapped; two in the longest). */
const VOCAB = [
  "agenda", "calendar", "meetings", "forgetting", "forgotten", "tomorrow", "schedule", "messages", "outstanding", "briefing", "pending",
  "reminders", "reminder", "slack", "today", "rehearsal", "working",
];

/** Real words that look like a typo of one of VOCAB's and must stay as they are ("resume" is RESUME, not the brief). */
const KEEP = new Set([
  "todos", "black", "stack", "slick", "snack", "resume", "resumes", "pendant", "message", "meeting", "agendas", "tomorrows", "slacks", "slacker",
  "remainder", "remainders",
]);

/** Optimal string alignment distance, stopped once it passes `max`. */
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) rows.push([i]);
  for (let j = 1; j <= b.length; j++) rows[0]![j] = j;
  for (let i = 1; i <= a.length; i++) {
    let best = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, rows[i - 2]![j - 2]! + 1);
      rows[i]![j] = v;
      best = Math.min(best, v);
    }
    if (best > max) return max + 1;
  }
  return rows[a.length]![b.length]!;
}

/** A word as meant: a shorthand spelt out, a typo in a long word put right when only one word of VOCAB is that close. */
function fix(word: string): string {
  if (SHORT[word]) return SHORT[word]!;
  if (word.length < 5 || KEEP.has(word) || VOCAB.includes(word)) return word;
  let found: string | null = null;
  let best = Infinity;
  let tie = false;
  for (const v of VOCAB) {
    const max = v.length >= 9 && word.length >= 8 ? 2 : 1;
    const dist = distance(word, v, max);
    if (dist > max) continue;
    if (dist < best) {
      [found, best, tie] = [v, dist, false];
    } else if (dist === best) tie = true;
  }
  return found && !tie ? found : word;
}

/** What may come before the question: a greeting, a name, "tell me", "can you tell me"… */
const LEAD = new RegExp(
  "^(?:(?:hey|hi|hello|good morning|good afternoon|good evening|pako|and|so|ok|okay|well|please|let me see|tell me|show me|give me"
    + "|i want to see|can you tell me|could you tell me|can you show me|could you show me|see) )+",
);
/** What may come after it: a name, "please", "thanks". */
const TAIL = / (?:pako|please|thanks|thank you|now)$/;
/** The same without the name: "how is Pako?" needs it ("how is it going?" alone is a greeting, for Claude). */
const TAIL_NOT_NAME = / (?:please|thanks|thank you|now)$/;

/** The question alone: shorthands and typos put right, the greeting and the "please" around it gone (and the name after it, unless kept). */
function core(text: string, keepName = false): string {
  const tail = keepName ? TAIL_NOT_NAME : TAIL;
  let s = plainWords(text).split(" ").filter(Boolean).map(fix).join(" ");
  s = s.replace(LEAD, "");
  for (let i = 0; i < 3 && tail.test(s); i++) s = s.replace(tail, "");
  return s.trim();
}

/**
 * How Pako itself is doing (HEALTH) and the dry run (REHEARSAL), read with the name kept: "how is Pako doing?" is about Pako, "how is it
 * going?" is not. A question about something else that merely mentions breaking ("is the car broken?") is not one of these.
 */
const PAKO_RULES: [View, RegExp][] = [
  // Never a greeting ("how are you, Pako?" is for Claude), never a word that could answer a question ("problems", "any problem?"): the
  // sentence names Pako, or everything.
  ["health", /^how (?:is|s) pako(?: doing| going| holding up)?(?: today)?$/],
  ["health", /^(?:is )?(?:everything|pako) (?:working|ok|okay|fine|running|up|good)(?: pako)?$/],
  ["health", /^(?:is )?(?:anything|something) (?:broken|down|failing|wrong) (?:with |in |on )?pako$/],
  ["health", /^(?:pako |system )?(?:status|health)(?: check)?$/],
  ["health", /^how (?:are|re) (?:the|your|my) (?:nudges|reminders) doing$/],
  // "Rehearse my speech" is for Claude: only a dry run named as one.
  ["rehearsal", /^(?:do|run|start|try)(?: me)? (?:a |an )?(?:rehearsal|dry run|practice run)(?: now)?$/],
  ["rehearsal", /^(?:rehearsal|rehearse|dry run)(?: pako)?$/],
  ["rehearsal", /^what would you (?:have told|tell|have said to|say to) me(?: today| now)?$/],
];

const DAY = "(today|tomorrow|this morning|this afternoon|tonight)";

/** The questions, each the whole message. The first that matches wins; meeting to-dos come before the open loops ("pending from…"). */
const RULES: [View | "day", RegExp][] = [
  // What came out of the meetings (MEETING TODOS).
  ["meeting-todos", /^what (?:came|has come) out of (?:my|the|this week s|today s) meetings(?: this week)?$/],
  ["meeting-todos", /^(?:my )?(?:meeting|meetings) (?:action items|todos|to dos|follow ups|followups|tasks)$/],
  ["meeting-todos", /^(?:my )?(?:action items|todos|to dos|follow ups|tasks) from (?:my |the )?meetings(?: this week)?$/],
  ["meeting-todos", /^what (?:s|is) (?:still )?(?:open|pending) from (?:my |the )?meetings(?: this week)?$/],
  ["meeting-todos", /^what did (?:we|i) agree (?:in|on|at) (?:my |the )?meetings(?: this week)?$/],
  // What the owner was asked or promised and is not done (PENDING / OPEN).
  ["followups", /^what am i forgetting(?: today)?$/],
  ["followups", /^(?:am i forgetting|did i forget|have i forgotten|i m forgetting|is there anything i m forgetting) (?:anything|something)(?: today)?$/],
  ["followups", /^(?:what (?:did|have) i forget(?:ten)?|anything i m forgetting)$/],
  ["followups", /^what (?:s|is) (?:still )?(?:pending|outstanding|open)(?: for me)?$/],
  ["followups", /^what do i (?:have|still have) (?:pending|outstanding|open)$/],
  ["followups", /^(?:my |any )?(?:open loops|pending items|open items|pending things|outstanding items|loose ends)$/],
  ["followups", /^(?:anything|is anything|is there anything) (?:pending|outstanding|open)$/],
  ["followups", /^what (?:did i promise|have i promised|do i owe people)$/],
  // The brief (BRIEF).
  ["brief", /^(?:my |the |today s |todays |daily |morning |my daily |my morning )?(?:brief|briefing)(?: for today)?$/],
  ["brief", /^(?:brief me|summarize my day|summarise my day|sum up my day|what s my brief|what s in my brief|my day summary|summary of my day)$/],
  // Slack's last day (SLACK).
  ["slack", /^(?:anything|something|any messages?)(?: new)? (?:on|in|from) slack(?: today)?$/],
  ["slack", /^what (?:s|is) (?:new |happening )?(?:on|in) slack(?: today)?$/],
  ["slack", /^(?:my |any |any new |new )?slack messages(?: today)?$/],
  ["slack", /^(?:check slack|what did i (?:get|miss) (?:on|in) slack|do i have (?:any )?(?:messages )?(?:on|in) slack)$/],
  // The pending reminders (REMINDERS).
  ["reminders", /^(?:my|the|any|pending|upcoming) reminders$/],
  ["reminders", /^(?:what reminders do i have|what are my reminders|do i have any reminders|list (?:my |the )?reminders)$/],
  ["reminders", /^what (?:will you|are you going to|are you) remind(?:ing)? me (?:of|about)$/],
  // The calendar (CALENDAR): a day named, or today and tomorrow.
  ["day", new RegExp(`^what (?:do i have|have i got|s on|is on|s happening|have i)(?: on)?(?: for)? ${DAY}$`)],
  ["day", new RegExp(`^what (?:s|is) (?:on )?(?:my|the) (?:agenda|calendar|schedule)(?: (?:for )?${DAY})?$`)],
  ["day", /^(?:my|today s|tomorrow s) (?:agenda|calendar|schedule)$/],
  ["day", new RegExp(`^(?:my |the )?(?:agenda|calendar|schedule) (?:for )?${DAY}$`)],
  ["day", new RegExp(`^(?:what does|how does) (?:my day|today|tomorrow|my day tomorrow|my day today) look(?: like)?$`)],
  ["day", /^how s (?:my day|today|tomorrow) (?:looking|shaping up)$/],
  ["day", new RegExp(`^(?:any|do i have any) (?:meetings|events|appointments|plans) ${DAY}$`)],
  ["day", new RegExp(`^what (?:meetings|events|appointments|plans) do i have(?: ${DAY})?$`)],
];

/** Which day the words name: today, tomorrow, or none (today and tomorrow). */
function dayOf(s: string): View {
  if (/\btomorrow\b/.test(s)) return "agenda-tomorrow";
  if (/\b(today|tonight|this morning|this afternoon)\b/.test(s)) return "agenda-today";
  return "agenda";
}

/**
 * The view the owner asks for in their own words, or null: not a clear question for one (a longer request, a question about something
 * else, a word that could be an answer). The door still decides whether that view is on (no Slack: the words go to Claude).
 */
export function matchView(text: string): View | null {
  if (!text || text.length > MAX_CHARS || /\n/.test(text.trim())) return null;
  const named = core(text, true);
  for (const [view, re] of PAKO_RULES) if (re.test(named)) return view;
  const s = core(text);
  if (!s || s.split(" ").length > 12) return null;
  for (const [view, re] of RULES) if (re.test(s)) return view === "day" ? dayOf(s) : view;
  return null;
}
