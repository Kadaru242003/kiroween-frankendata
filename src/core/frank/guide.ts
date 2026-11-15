/**
 * "Ask Little Frank": the offline guide (pure; no React, no DOM, NO NETWORK).
 *
 * A local table of intents, each with keywords, example questions and an
 * answer in Frank's voice (short, friendly, a little spooky). Matching is
 * case-insensitive keyword and synonym matching on the normalized question. The
 * only import is `describeEgress`, a pure function, so the privacy answer is
 * built from the same text as the "What leaves the browser?" disclosure and
 * cannot drift from it. Nothing here calls `fetch` or any other network API.
 */

import { describeEgress } from "../egress-description";
import { GUIDE_MIN_INTENTS } from "./constants";

export interface GuideIntent {
  id: string;
  /** Normalized words or phrases that point to this intent. */
  keywords: string[];
  /** Example questions; each must map back to this intent. */
  examples: string[];
  /** Paragraphs of plain text, in Frank's voice. `now` is only used by dated answers. */
  answer: (now: Date) => string[];
}

/** Shown when nothing matches, followed by the suggested-question chips. */
export const FALLBACK_TEXT = "I only know about this lab. Try one of these:";

/** What he says before the first question. */
export const GREETING = "Good day, friend. I am Little Frank. Ask me anything about this lab.";

/**
 * The intent table. Order matters: ties go to the earlier intent. Frank is the
 * creature of Mary Shelley's 1818 novel: gentle, eloquent, well read. Every
 * answer is short (1 to 3 sentences) except the privacy answer, which carries
 * the exact "What leaves the browser?" text.
 */
export const INTENTS: GuideIntent[] = [
  {
    id: "start",
    keywords: ["start", "begin", "get started", "getting started", "new here", "what do i do", "first step", "where do i go"],
    examples: ["How do I start?", "Where do I begin?", "I am new here, what do I do?"],
    answer: () => [
      "Welcome, friend. Click Load business demo and I shall wake. Then click Stitch tables, or drop your own CSV or Excel files on the slab.",
    ],
  },
  {
    id: "privacy",
    keywords: [
      "safe", "safety", "privacy", "private", "secure", "security", "upload", "uploaded",
      "server", "leave the browser", "leaves the browser", "who sees", "tracking", "spy",
    ],
    examples: ["Is my data safe?", "What leaves the browser?", "Do you upload my files?", "Is my data private?"],
    answer: privacyAnswer,
  },
  {
    id: "files",
    keywords: ["file", "files", "csv", "xlsx", "excel", "spreadsheet", "format", "formats", "size limit", "too big", "how big", "load my own"],
    examples: ["What files can I load?", "Can I use Excel files?", "What is the file size limit?"],
    answer: () => [
      "I read CSV and Excel (.xlsx) files; drop them on the slab or use Add files.",
      "Each becomes a typed table, right here in your browser. A file too large is refused politely, so nothing freezes.",
    ],
  },
  {
    id: "demos",
    keywords: ["demo", "demos", "sample data", "example data", "business demo", "try it"],
    examples: ["What are the demos?", "What does Load business demo do?", "Which demo should I try?"],
    answer: () => [
      "The demos let you watch me work. Business pairs a CRM export with a billing export that never agree, and Lab brings three messy lab files; the next-month demos bring new files for a saved recipe.",
      "Loading a demo replaces the tables on the slab.",
    ],
  },
  {
    id: "stitching",
    keywords: ["stitch", "stitching", "stitched", "join", "joins", "combine", "combine my files", "merge", "two tables", "stitch tables"],
    examples: ["What does stitching do?", "What is stitching?", "How do I join two tables?", "How do I combine my files?"],
    answer: () => [
      "I was stitched from mismatched parts too. Let's make your tables whole.",
      "Click Stitch tables, approve what you trust, then Confirm & stitch; nothing changes until you approve, and your originals are never touched.",
    ],
  },
  {
    id: "matches",
    keywords: ["confidence", "score", "scores", "approve", "reject", "match", "matches", "proposal", "proposals", "suggestion", "suggestions", "approve all"],
    examples: ["What do the confidence scores mean?", "How do I approve a match?", "What is a match proposal?"],
    answer: () => [
      "Each match carries a confidence from 0 to 100 percent, built from names, types and values. Approve the ones you trust, reject the rest, or use Approve all suggestions.",
      "You may also change a match before you approve it.",
    ],
  },
  {
    id: "cleanup",
    keywords: ["clean", "cleaning", "cleanup", "cleanups", "duplicate", "duplicates", "outlier", "outliers", "whitespace", "casing", "standardize", "category", "categories"],
    examples: ["What does cleaning do?", "How are duplicates removed?", "What are outliers?"],
    answer: () => [
      "I can suggest tidying: trimming stray spaces, fixing mixed case, standardizing spellings like Swamp Wraith and swamp-wraith, removing duplicate rows and flagging outliers.",
      "It all goes into new copies, so your originals stay as they were.",
    ],
  },
  {
    id: "join",
    keywords: ["join key", "key", "anchor", "fan out", "fanout", "more rows", "many to many", "left join"],
    examples: ["What is the join key?", "What is an anchor table?", "What does fan out mean?", "Why do I get more rows than I started with?"],
    answer: () => [
      "The join key is the pair of columns that lines the rows up, and the anchor is the table the result is built from. I suggest a default for both, and you may change them in the Join panel.",
      "If the result has more rows than the anchor, it fanned out, and you can undo the stitch.",
    ],
  },
  {
    id: "undo-reset",
    keywords: ["undo", "undo a stitch", "reset", "start over", "clear", "wipe", "remove tables", "cancel"],
    examples: ["How do I undo a stitch?", "How do I start over?", "What does Reset lab do?"],
    answer: () => [
      "You can undo a stitch: I drop only the tables I made, and your originals remain.",
      "Reset lab clears the slab, and I shall be dramatic about it.",
    ],
  },
  {
    id: "autopsy",
    keywords: ["autopsy", "health", "health score", "case file", "diagnose", "diagnosis", "stethoscope", "fix it", "fix all", "fix"],
    examples: ["What is an Autopsy?", "What does the health score mean?", "How do I fix a table's problems?"],
    answer: () => [
      "Let me examine the patient. An Autopsy is a health check of one table: a score out of 100, what is wrong column by column, and fixes to send to the stitching table.",
      "I only read your data; nothing changes until you review the fixes.",
    ],
  },
  {
    id: "recipes",
    keywords: ["recipe", "recipes", "reuse", "next month", "new files", "save a stitch", "sql script", "replay"],
    examples: ["How do recipes work?", "What is a recipe?", "How do I reuse a stitch on new files?", "What is the SQL script?"],
    answer: () => [
      "Even I keep notes in a journal. A recipe saves your matches, cleanups, anchor and keys, with no row values in it.",
      "Next month, load new files and click Apply recipe, and I pre-approve the steps for you to confirm; the same steps can be saved as a SQL script.",
    ],
  },
  {
    id: "ask-lab",
    keywords: ["ask the lab", "ask lab", "what can i ask", "question", "questions", "query", "sql", "chart", "charts", "starter", "chat"],
    examples: ["What can I ask the Lab?", "How do I ask a question?", "Can I query my tables?", "What are the starter questions?"],
    answer: () => [
      "Ask the Lab turns a question into one read-only SQL query and shows a table, sometimes a chart.",
      "Try the starter questions, or type your own when AI is on. It can never change your data.",
    ],
  },
  {
    id: "ai",
    keywords: ["ai", "artificial intelligence", "language model", "model", "ai off", "ai switch", "fully local", "offline", "llm"],
    examples: ["What does AI do here?", "Is the AI required?", "How do I turn the AI off?", "Does it use a language model?"],
    answer: () => [
      "The AI is optional. It only nudges the confidence of matches I already found, and helps write your questions as SQL.",
      "Everything works fully offline without it, and the AI switch is in the header.",
    ],
  },
  {
    id: "export",
    keywords: ["export", "download", "save as", "csv out", "get out"],
    examples: ["How do I export my data?", "Can I download the result?", "How do I get a CSV out?"],
    answer: () => [
      "Each table card has export buttons for CSV and Excel. After you stitch, export the stitched result too, or save a recipe or a SQL script.",
    ],
  },
  {
    id: "built",
    keywords: ["built", "build", "made", "made with", "kiro", "spec driven", "how was this", "behind the scenes", "tech stack", "stack", "who made", "who built", "creators"],
    examples: ["How was this built?", "Who made FrankenData?", "What is this made with?", "Was this built with Kiro?"],
    answer: () => [
      "FrankenData was built spec-driven with Kiro: specs with requirements, design and tasks, steered by steering docs, hooks and an MCP server.",
      "I was specced too, which is a strange thing to learn.",
    ],
  },
  {
    id: "who",
    keywords: ["who are you", "what are you", "little frank", "frank", "monster", "creature", "mascot", "your name", "specimen"],
    examples: ["Who are you?", "What are you?", "Why is there a creature in the corner?", "What is Little Frank?"],
    answer: () => [
      "I am the creature of this lab, stitched from mismatched parts, and here they call me Little Frank.",
      "I long for a companion, so I am glad you came. Tap me, if you like; I am a little ticklish.",
    ],
  },
  {
    id: "frankenstein",
    keywords: ["frankenstein", "your name frankenstein", "dr frankenstein", "doctor frankenstein", "victor", "your maker", "who made you", "who created you"],
    examples: ["Are you Frankenstein?", "Who is Frankenstein?", "Is your name Frankenstein?", "Who created you?"],
    answer: () => [
      "Gently, friend: Frankenstein was my maker, Victor. I am the creature, and in this lab people call me Little Frank.",
    ],
  },
  {
    id: "eat",
    keywords: ["eat", "eats", "eating", "food", "diet", "hungry", "hunger", "meal", "meat", "acorns", "berries", "vegetarian"],
    examples: ["What do you eat?", "What is your diet?", "Do you eat meat?", "Are you hungry?"],
    answer: () => [
      "Only acorns and berries, and never meat. I could not bear to harm a lamb.",
      "Spreadsheets I merely read.",
    ],
  },
  {
    id: "read",
    keywords: ["read", "reading", "book", "books", "paradise lost", "plutarch", "werther", "favorite book", "library"],
    examples: ["What do you read?", "Which books do you know?", "Have you read Paradise Lost?", "What is your favorite book?"],
    answer: () => [
      "I learned my letters by watching a family through a chink in a cottage wall.",
      "Then I found three books: Paradise Lost, Plutarch's Lives and The Sorrows of Young Werther. In Adam I saw myself, made and left alone.",
    ],
  },
  {
    id: "born",
    keywords: [
      "when were you made", "when were you born", "when were you created", "when were you built",
      "when were you stitched", "your birthday", "birthday", "born", "how old", "when did you wake",
    ],
    examples: ["When were you made?", "When were you born?", "How old are you?", "When is your birthday?"],
    answer: (now) => [
      "On \"a dreary night of November\", as my maker's tale tells it, and he fled the room when I opened my eyes.",
      ...(now.getMonth() === 10 ? ["That's this month!"] : []),
    ],
  },
  {
    id: "calm",
    keywords: ["calm", "calm frank", "animation", "animations", "motion", "still", "stop moving", "reduce motion", "poke", "poking", "easter egg", "eyes"],
    examples: ["How do I stop the animations?", "Can you hold still?", "What is Calm Frank?", "Reduce motion please"],
    answer: () => [
      "Wish me to sit still? Tick Calm Frank below, and I stop my animations but still change pose and speak.",
      "If your device asks for reduced motion, I already keep still.",
    ],
  },
];

if (INTENTS.length < GUIDE_MIN_INTENTS) {
  throw new Error("The guide needs at least GUIDE_MIN_INTENTS intents");
}

/** The suggested-question chips: the first example of eight intents. */
export const GUIDE_CHIP_INTENTS = [
  "start", "stitching", "privacy", "autopsy", "recipes", "ask-lab", "ai", "built",
] as const;

export const GUIDE_CHIPS: string[] = GUIDE_CHIP_INTENTS.map((id) => {
  const intent = INTENTS.find((i) => i.id === id);
  if (!intent) throw new Error(`Missing intent ${id}`);
  return intent.examples[0];
});

/**
 * The answer to "Is my data safe?". Built from `describeEgress()` so it matches
 * the "What leaves the browser?" disclosure line for line.
 */
function privacyAnswer(): string[] {
  const egress = describeEgress();
  return [
    "I learned everything by watching quietly through a crack in the wall. I watch your data the same way. I never carry it off.",
    "Your files are read and kept only in this browser tab. Nothing is uploaded and nothing is saved, so a refresh clears the lab.",
    "When AI is On, only this is sent:",
    ...egress.sent,
    egress.neverSent,
    "With AI off, nothing is sent at all.",
  ];
}

/** Lower case, punctuation to spaces, spaces collapsed. */
export function normalizeQuestion(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** What a question matched. */
export type GuideMatch =
  | { kind: "intent"; intent: GuideIntent; score: number }
  | { kind: "fallback" };

/**
 * Match a question to the best intent. Each matching keyword adds its word
 * count; the highest score wins and ties go to the earlier intent. No match is
 * the fallback.
 */
export function matchIntent(text: string): GuideMatch {
  const normalized = ` ${normalizeQuestion(text)} `;
  if (normalized.trim() === "") return { kind: "fallback" };
  let best: { intent: GuideIntent; score: number } | null = null;
  for (const intent of INTENTS) {
    let score = 0;
    for (const keyword of intent.keywords) {
      if (normalized.includes(` ${keyword} `)) score += keyword.split(" ").length;
    }
    if (score > 0 && (best === null || score > best.score)) best = { intent, score };
  }
  return best ? { kind: "intent", ...best } : { kind: "fallback" };
}

/** What the panel shows for a question. */
export interface GuideAnswer {
  intentId: string | null;
  paragraphs: string[];
  /** Whether to show the chips under the answer (the fallback does). */
  showChips: boolean;
}

export function answerFor(text: string, now: Date = new Date()): GuideAnswer {
  const match = matchIntent(text);
  if (match.kind === "fallback") {
    return { intentId: null, paragraphs: [FALLBACK_TEXT], showChips: true };
  }
  return { intentId: match.intent.id, paragraphs: match.intent.answer(now), showChips: false };
}

// ── Context tip ──────────────────────────────────────────────────────────────

export interface TipState {
  tableCount: number;
  /** Proposals exist and nothing is stitched yet. */
  proposalsPending: boolean;
  stitched: boolean;
}

/** The one-line tip for the app state. The more advanced state wins. */
export function contextTip(state: TipState): string {
  if (state.stitched) return "Save a recipe, or ask the Lab a question.";
  if (state.proposalsPending) return "Approve the matches you trust, then Confirm & stitch.";
  if (state.tableCount >= 2) return "Click Stitch tables.";
  if (state.tableCount === 1) return "Add another file, then click Stitch tables.";
  return "Click Load business demo to wake me up.";
}
