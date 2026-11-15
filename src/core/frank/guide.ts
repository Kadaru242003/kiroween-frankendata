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
  /** Paragraphs of plain text, in Frank's voice. */
  answer: () => string[];
}

/** Shown when nothing matches, followed by the suggested-question chips. */
export const FALLBACK_TEXT = "I only know about this lab. Try one of these:";

const STITCH_STEPS =
  "Nothing changes until you approve. Click Stitch tables, approve what you trust, then Confirm & stitch and Apply & stitch.";

/** The intent table. Order matters: ties go to the earlier intent. */
export const INTENTS: GuideIntent[] = [
  {
    id: "start",
    keywords: ["start", "begin", "get started", "getting started", "new here", "what do i do", "first step", "where do i go"],
    examples: ["How do I start?", "Where do I begin?", "I am new here, what do I do?"],
    answer: () => [
      "Welcome to my lab! Click Load business demo and I will wake right up.",
      "Then click Stitch tables to sew the two files together. Or drop your own CSV or Excel files on the slab.",
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
      "I eat CSV and Excel (.xlsx) files. Drop them on the slab, or use Add files.",
      "I read them right here in your browser and turn each one into a typed table. A file that is too large is refused with a message, so nothing freezes.",
    ],
  },
  {
    id: "demos",
    keywords: ["demo", "demos", "sample data", "example data", "business demo", "try it"],
    examples: ["What are the demos?", "What does Load business demo do?", "Which demo should I try?"],
    answer: () => [
      "The demos let you watch me work without your own files.",
      "Business is a CRM export and a billing export that never agree. Business: next month brings April invoices to try the March recipe on. Lab is three messy lab files, Mismatched is two files with different headers, and Lab: next month has new lab rows for a lab recipe.",
      "Loading a demo replaces the tables on the slab. Add files adds on top.",
    ],
  },
  {
    id: "stitching",
    keywords: ["stitch", "stitching", "stitched", "join", "joins", "combine", "combine my files", "merge", "two tables", "stitch tables"],
    examples: ["What does stitching do?", "What is stitching?", "How do I join two tables?", "How do I combine my files?"],
    answer: () => [
      "Stitching sews two or more tables into one. I compare column names, types and values, and suggest which columns mean the same thing and what to clean.",
      `${STITCH_STEPS} Your original tables are never touched.`,
    ],
  },
  {
    id: "matches",
    keywords: ["confidence", "score", "scores", "approve", "reject", "match", "matches", "proposal", "proposals", "suggestion", "suggestions", "approve all"],
    examples: ["What do the confidence scores mean?", "How do I approve a match?", "What is a match proposal?"],
    answer: () => [
      "Each match has a confidence from 0 to 100 percent, built from the column names, the types and the values. High means I am quite sure.",
      "Approve the ones you trust, reject the rest, or use Approve all suggestions. You can also change a match before you approve it.",
    ],
  },
  {
    id: "cleanup",
    keywords: ["clean", "cleaning", "cleanup", "cleanups", "duplicate", "duplicates", "outlier", "outliers", "whitespace", "casing", "standardize", "category", "categories"],
    examples: ["What does cleaning do?", "How are duplicates removed?", "What are outliers?"],
    answer: () => [
      "I can suggest cleanups: trim stray spaces, fix mixed upper and lower case, standardize spellings like Swamp Wraith and swamp-wraith, remove duplicate rows and flag outliers.",
      "Cleanups go into new copies of your tables. The originals stay as they are.",
    ],
  },
  {
    id: "join",
    keywords: ["join key", "key", "anchor", "fan out", "fanout", "more rows", "many to many", "left join"],
    examples: ["What is the join key?", "What is an anchor table?", "What does fan out mean?", "Why do I get more rows than I started with?"],
    answer: () => [
      "The join key is the pair of columns that lines the rows up. The anchor is the table the result is built from. I suggest a default for both, and you can change them in the Join panel before you apply.",
      "If the result has more rows than the anchor, the join fanned out. I grab my head and warn you, and you can undo the stitch.",
    ],
  },
  {
    id: "undo-reset",
    keywords: ["undo", "undo a stitch", "reset", "start over", "clear", "wipe", "remove tables", "cancel"],
    examples: ["How do I undo a stitch?", "How do I start over?", "What does Reset lab do?"],
    answer: () => [
      "You can undo a stitch after you apply it: I drop the tables I made and your originals stay as they were.",
      "Reset lab clears everything on the slab so you can start fresh. I will be dramatic about it.",
    ],
  },
  {
    id: "autopsy",
    keywords: ["autopsy", "health", "health score", "case file", "diagnose", "diagnosis", "stethoscope", "fix it", "fix all", "fix"],
    examples: ["What is an Autopsy?", "What does the health score mean?", "How do I fix a table's problems?"],
    answer: () => [
      "An Autopsy is a health check for one table. Click Autopsy on a table card to open its case file: a health score out of 100, what is wrong column by column, and fixes you can send to the stitching table.",
      "It only reads your data. Nothing changes until you review and apply the fixes.",
    ],
  },
  {
    id: "recipes",
    keywords: ["recipe", "recipes", "reuse", "next month", "new files", "save a stitch", "sql script", "replay"],
    examples: ["How do recipes work?", "What is a recipe?", "How do I reuse a stitch on new files?", "What is the SQL script?"],
    answer: () => [
      "A recipe saves what you did in a stitch: the matches, the cleanups, the anchor and the keys. It has no row values in it.",
      "Next month, load the new files, click Apply recipe, and I pre-approve the same steps. You still review and confirm. You can also save the same steps as a SQL script.",
    ],
  },
  {
    id: "ask-lab",
    keywords: ["ask the lab", "ask lab", "what can i ask", "question", "questions", "query", "sql", "chart", "charts", "starter", "chat"],
    examples: ["What can I ask the Lab?", "How do I ask a question?", "Can I query my tables?", "What are the starter questions?"],
    answer: () => [
      "Ask the Lab turns a question into one read-only SQL query and shows the answer as a table, sometimes with a chart. Try the starter questions, or type your own when AI is on.",
      "Ask things like how many rows per species, or revenue by region. It cannot change your data.",
    ],
  },
  {
    id: "ai",
    keywords: ["ai", "artificial intelligence", "language model", "model", "ai off", "ai switch", "fully local", "offline", "llm"],
    examples: ["What does AI do here?", "Is the AI required?", "How do I turn the AI off?", "Does it use a language model?"],
    answer: () => [
      "The AI is optional. It only nudges the confidence of matches I already found, and helps Ask the Lab write your question as SQL.",
      "Everything works fully offline without it. The AI switch is in the header: turn it off and I stay fully local.",
    ],
  },
  {
    id: "export",
    keywords: ["export", "download", "save as", "csv out", "get out"],
    examples: ["How do I export my data?", "Can I download the result?", "How do I get a CSV out?"],
    answer: () => [
      "Each table card has export buttons for CSV and Excel. After you stitch, you can export the stitched result too, and save a recipe or a SQL script.",
    ],
  },
  {
    id: "built",
    keywords: ["built", "build", "made", "made with", "kiro", "spec driven", "how was this", "behind the scenes", "tech stack", "stack", "who made", "who built", "creators"],
    examples: ["How was this built?", "Who made FrankenData?", "What is this made with?", "Was this built with Kiro?"],
    answer: () => [
      "FrankenData was built spec-driven with Kiro: specs with requirements, a design and tasks for every feature. Steering docs, hooks and an MCP server kept the work on track.",
      "I was specced too. Spooky.",
    ],
  },
  {
    id: "who",
    keywords: ["who are you", "what are you", "little frank", "frank", "monster", "mascot", "your name", "specimen"],
    examples: ["Who are you?", "What are you?", "Why is there a monster in the corner?", "What is Little Frank?"],
    answer: () => [
      "I am Little Frank, the lab's specimen, stitched together from spreadsheet cells.",
      "I react to what you do: loading, stitching, asking. Poke me from this panel if you dare.",
    ],
  },
  {
    id: "calm",
    keywords: ["calm", "calm frank", "animation", "animations", "motion", "still", "stop moving", "reduce motion", "poke", "poking", "easter egg", "eyes"],
    examples: ["How do I stop the animations?", "Can you hold still?", "What is Calm Frank?", "Reduce motion please"],
    answer: () => [
      "Want me to sit still? Tick Calm Frank below and I stop the animations. I still change pose and talk. If your device asks for reduced motion, I already stay calm.",
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
    "Yes. Your files are read and kept only in this browser tab. Nothing is uploaded and nothing is saved, so a refresh clears the lab.",
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

export function answerFor(text: string): GuideAnswer {
  const match = matchIntent(text);
  if (match.kind === "fallback") {
    return { intentId: null, paragraphs: [FALLBACK_TEXT], showChips: true };
  }
  return { intentId: match.intent.id, paragraphs: match.intent.answer(), showChips: false };
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
