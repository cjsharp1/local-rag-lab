/**
 * eval.ts — the scorecard (PLAN §8). Code scores everything; no model judges.
 *
 * Run it with:  npm run eval -- --check     check the question set against the corpus
 *
 * Coming in later build steps:
 *   step 7   the retrieval pass: for each question and each search
 *            configuration, whether the gold spans came back (hit@k,
 *            partial, MRR). No chat model needed.
 *   step 9   the answer pass and the rerank pass, with the chat model,
 *            and docs/scorecard.md.
 *
 * --check is the fast one, and the one to run after editing any document
 * or question. It loads the 30 question files (server/questions.ts),
 * validates their shape, and checks every gold span, required fact and
 * forbidden fact against the corpus. It needs no model and no index. If
 * it passes, every expected answer the scorecard uses is at least
 * present, word for word, in the documents it claims to come from.
 */

import { loadCorpus } from "../tool-server/corpus.js";
import { checkQuestions, loadQuestions, QuestionFileError } from "../server/questions.js";

function check(): void {
  let questions;
  try {
    questions = loadQuestions();
  } catch (error: unknown) {
    if (error instanceof QuestionFileError) {
      console.error(`\n${error.message}\n`);
      process.exit(1);
    }
    throw error;
  }

  const docs = loadCorpus();
  const problems = checkQuestions(questions, docs);
  const spans = questions.reduce((n, q) => n + q.hops.flat().length, 0);

  if (problems.length > 0) {
    console.error(`\n${questions.length} questions, ${problems.length} problem${problems.length === 1 ? "" : "s"}:\n`);
    for (const p of problems) console.error(`  ${p}`);
    console.error("");
    process.exit(1);
  }
  console.log(`\n${questions.length} questions, all spans found (${spans} gold spans in ${docs.length} documents; ` +
    "every required fact is in its own gold text, every forbidden fact is in the corpus and not in its gold text).\n");
}

if (process.argv.includes("--check")) {
  check();
} else {
  console.error("\nOnly --check is built so far:  npm run eval -- --check");
  console.error("The retrieval pass arrives at build step 7, the answer pass at step 9.\n");
  process.exit(1);
}
