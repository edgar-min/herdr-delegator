// Fixed English question phrases. Every question names its target by a backticked state path so the model
// (which never sees question IDs) knows which item it is judging. Bump QUESTION_VERSION when any phrase changes;
// calibration rows carry it so thresholds are never mixed across wordings.
import type { Question } from "./client.js";

export const QUESTION_VERSION = "2026-09-20.3";

/**
 * rank: two phrasings of the same proposition per item, combined by max in code.
 * `kind` selects the vocabulary: a path candidate (only its path is known) or a text chunk (its text is in state).
 */
export function rankQuestions(count: number, kind: "path" | "chunk"): Record<string, Question> {
  const q: Record<string, Question> = {};
  for (let i = 0; i < count; i++) {
    const item = `\`items[${i}]\``;
    if (kind === "path") {
      q[`a_${i}`] = { type: "noul", instructions: `Judging only from the path and file name in ${item}.path, the document it points to would help with the intent in \`intent\`.` };
      q[`b_${i}`] = { type: "noul", instructions: `The file named by ${item}.path likely contains information related to the intent in \`intent\`.` };
    } else {
      q[`a_${i}`] = { type: "noul", instructions: `The text in ${item}.text contains information relevant to the intent in \`intent\`.` };
      q[`b_${i}`] = { type: "noul", instructions: `Reading ${item}.text (titled ${item}.title) would help someone pursuing the intent in \`intent\`.` };
    }
  }
  return q;
}

/** The three `score` questions of moment `authoring`, in table order. */
export const AUTHORING_SCORES = [
  { id: "purpose", label: "purpose understandable without prior context" },
  { id: "terms", label: "terms defined or self-evident" },
  { id: "next_action", label: "next action unambiguous" },
] as const;

/**
 * authoring: judged before an assignment is dispatched. `conditions[i].text` is one bullet of the artifact's
 * "# Completion conditions" section; `profiles` maps each configured worker profile name to its `intent` string,
 * which is what the Choice compares the work against.
 */
export function authoringQuestions(conditionCount: number, profiles: Record<string, string>): Record<string, Question> {
  const q: Record<string, Question> = {
    purpose: {
      type: "score",
      instructions: "A worker who has never seen this project reads `assignment`. How completely does `assignment.goal` state what the work is for?",
      criteria: [
        "`assignment.goal` names no purpose: it lists actions or conditions only.",
        "The purpose can be guessed from `assignment.goal`, but only by assuming which project or prior conversation it belongs to.",
        "`assignment.goal` states the purpose and leaves one detail the worker would have to assume.",
        "`assignment.goal` states the purpose explicitly, and no prior context is needed to see what the work is for.",
      ],
    },
    terms: {
      type: "score",
      instructions: "How many of the load-bearing terms used in `assignment` are defined inside `assignment` itself or self-evident to a worker with no prior context?",
      criteria: [
        "Load-bearing terms are used undefined, and a worker could not act without asking what they mean.",
        "Several load-bearing terms need a document or conversation `assignment` does not name.",
        "One load-bearing term needs outside context; the rest are defined in `assignment` or self-evident.",
        "Every load-bearing term is defined in `assignment`, pinned to a document it names, or self-evident.",
      ],
    },
    next_action: {
      type: "score",
      instructions: "After reading `assignment`, how unambiguous is the first action the worker takes?",
      criteria: [
        "`assignment` names no first action: which file, call, or artifact to start from is absent.",
        "Two different first actions fit `assignment` equally well, and it does not say which.",
        "The first action is clear, and one of its inputs (a path, a coordinate, a command) still has to be inferred.",
        "The first action and the inputs it needs are both stated in `assignment`.",
      ],
    },
  };
  for (let i = 0; i < conditionCount; i++) {
    q[`cond_${i}`] = {
      type: "noul",
      instructions: `Completion condition \`conditions[${i}].text\` can be checked by observing a file, a command's output, or an artifact.`,
      criteria: {
        true: "Someone other than the worker could run or open something named by the condition and see whether it holds.",
        false: "The only way to know the condition holds is the worker's own assertion that it did the work.",
      },
    };
  }
  q.maturity = {
    type: "noul",
    instructions: "`assignment` already decides the design questions its work needs, so the worker implements rather than chooses an approach.",
    criteria: {
      true: "Shapes, names, formats, and boundaries the work depends on are fixed by `assignment` or by a document it pins.",
      false: "The worker would have to pick a structure, format, or boundary that `assignment` leaves open.",
    },
  };
  q.profile = {
    type: "choice",
    instructions: "Which worker profile, described by the criteria, fits the work `assignment` describes?",
    criteria: profiles,
  };
  return q;
}

/** The `score` levels of the settlement next action, lowest first; the label is read from the argmax level. */
export const SETTLEMENT_ACTIONS = ["reject", "requery", "accept"] as const;

/**
 * settlement: judged when a lane reports a boundary. `conditions[i].text` is a completion-condition bullet,
 * `report.paragraphs[j]` is one paragraph of that assignment's segment of the lane report, and `owned_diff`
 * holds the diff of the paths the assignment declared as its own. Every evidence Choice carries a `none`
 * sentinel, because a report that supports nothing must be able to say so.
 */
export function settlementQuestions(conditionCount: number, paragraphCount: number): Record<string, Question> {
  const paragraphs: Record<string, string | null> = {};
  for (let j = 0; j < paragraphCount; j++) paragraphs[String(j)] = null;
  paragraphs.none = "No paragraph in `report.paragraphs` supports this condition.";
  const q: Record<string, Question> = {};
  for (let i = 0; i < conditionCount; i++) {
    q[`met_${i}`] = {
      type: "noul",
      instructions: `Completion condition \`conditions[${i}].text\` is met according to \`report.paragraphs\` and \`owned_diff\`.`,
      criteria: {
        true: "A paragraph of the report, or a hunk of the owned diff, shows the condition holding.",
        false: "The report and the owned diff leave the condition unshown, contradicted, or only promised.",
      },
    };
    q[`evid_${i}`] = {
      type: "choice",
      instructions: `Which entry of \`report.paragraphs\` states the evidence for completion condition \`conditions[${i}].text\`? The keys are indices into \`report.paragraphs\`.`,
      criteria: paragraphs,
    };
  }
  q.claims_evidence = {
    type: "noul",
    instructions: "The paragraphs in `report.paragraphs` separate what the worker claims from the evidence it cites.",
    criteria: {
      true: "Claims are accompanied by a command, an output, a path, or a hash that a reader could check independently.",
      false: "The report asserts results without citing anything a reader could check.",
    },
  };
  q.out_of_scope = {
    type: "noul",
    instructions: "The paths listed in `changed_paths.unowned` indicate a change outside the write ownership declared in `ownership.declarations`.",
    criteria: {
      true: "At least one unowned path is a file this assignment's declared ownership does not cover and its work would not have to touch.",
      false: "The unowned paths are unrelated to this assignment's work, empty, or already explained by the shared working directory.",
    },
  };
  q.next_action = {
    type: "score",
    instructions: "What should the orchestrator do with this assignment, given `conditions`, `report.paragraphs`, and `owned_diff`?",
    criteria: [
      "Reject: a completion condition is contradicted or plainly unmet, and the report shows work that does not satisfy it.",
      "Requery: the report is plausible but the evidence for at least one condition is missing or ambiguous, so ask for that evidence.",
      "Accept: every completion condition is supported by a paragraph of the report or by the owned diff.",
    ],
  };
  return q;
}

/**
 * check: each sentence is judged for support against the chunks of the reference documents. The Choice carries
 * the same `none` sentinel, so an unsupported sentence names no chunk instead of the least-bad one.
 */
export function checkQuestions(sentenceCount: number, chunkCount: number): Record<string, Question> {
  const chunks: Record<string, string | null> = {};
  for (let j = 0; j < chunkCount; j++) chunks[String(j)] = null;
  chunks.none = "No chunk in `chunks` supports the sentence.";
  const q: Record<string, Question> = {};
  for (let i = 0; i < sentenceCount; i++) {
    q[`sup_${i}`] = {
      type: "noul",
      instructions: `The sentence in \`sentences[${i}].text\` is supported by at least one chunk in \`chunks\`.`,
      criteria: {
        true: "A chunk states the sentence, or states something from which the sentence follows directly.",
        false: "No chunk states it; the chunks are silent about it or say something else.",
      },
    };
    q[`src_${i}`] = {
      type: "choice",
      instructions: `Which entry of \`chunks\` supports the sentence in \`sentences[${i}].text\`? The keys are indices into \`chunks\`.`,
      criteria: chunks,
    };
  }
  return q;
}

/** The judgment ladder of moment `escalate`, cheapest rung first. */
export const ESCALATION_RUNGS = ["autonomous", "machine_check", "human"] as const;

/**
 * escalate: the agent is about to interrupt a human. The state is `question` (what it would ask) and
 * `known_context` (what the mandate, plan, or evidence already say). Code turns the three answers into one
 * line — asking a human is warranted when the rung is `human`, or when the question blocks work and a wrong
 * autonomous answer could not be undone cheaply.
 */
export function escalateQuestions(): Record<string, Question> {
  return {
    rung: {
      type: "choice",
      instructions: "Which rung of the judgment ladder does the decision in `question` belong to, given `known_context`?",
      criteria: {
        autonomous: "The mandate, plan, project rules, or evidence already fix the answer; the agent decides without asking.",
        machine_check: "The answer can be observed directly by running a command, reading a file, or calling a tool; no human is needed.",
        human: "It is a genuine value judgment, a scope change, an irreversible external action, a governance or account/secret decision, or an approval the human reserved.",
      },
    },
    blocking: {
      type: "noul",
      instructions: "Work cannot safely continue until `question` is answered.",
      criteria: {
        true: "Every remaining path depends on the answer, so continuing would mean guessing it.",
        false: "Other work in scope proceeds while the question stays open.",
      },
    },
    reversible: {
      type: "noul",
      instructions: "If the agent decided `question` itself and was wrong, the mistake could be undone cheaply.",
      criteria: {
        true: "The wrong choice is undone by editing a file, reverting a commit, or calling again.",
        false: "The wrong choice spends money, publishes something, touches an account, or destroys state a later call cannot restore.",
      },
    },
  };
}
