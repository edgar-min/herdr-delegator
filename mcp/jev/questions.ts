// Fixed English question phrases. Every question names its target by a backticked state path so the model
// (which never sees question IDs) knows which item it is judging. Bump QUESTION_VERSION when any phrase changes;
// calibration rows carry it so thresholds are never mixed across wordings.
import type { Question } from "./client.js";

export const QUESTION_VERSION = "2026-09-20.1";

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
