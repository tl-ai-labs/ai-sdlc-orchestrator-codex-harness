/**
 * Actor gutter for the run report. A fixed-width left column lets a reader
 * see who produced each line without parsing text — the single most misread
 * fact in a multi-model run is "who actually wrote the code".
 *
 * The codex cast differs from the Claude harness's in a way that matters
 * here: there, one premium model both conducted the run AND did the judgment
 * work, so a single `[C]` covered both. Here the conductor and the judgment
 * worker are separate calls to the same model family — the conductor's cost
 * is modeled from its own turns, the judgment worker's is vendor-metered
 * through the bridge. Collapsing them into one tag would hide exactly the
 * distinction the cost report exists to make.
 */

export const ACTOR = {
  driver: "[D]",    // the codex conductor — runs the loop, writes no shipped content
  judge: "[J]",     // GPT judgment worker, dispatched through the bridge
  worker: "[G]",    // Gemini mechanical tier
  handoff: "[→]",   // the dispatch itself: packet written, bridge called, result read
  script: "[·]",    // a scripted step of our own — verify, report
};

/**
 * `delegated: false` collapses to plain indent — a run with one actor has
 * nothing to attribute. Width matches the widest tag.
 */
export const gutter = (tag, delegated = true) => (delegated ? `${String(tag).padEnd(3)} ` : "  ");

export const ACTOR_LEGEND = [
  [ACTOR.driver, "the conductor — plans, gates, integrates; authors no shipped content"],
  [ACTOR.handoff, "the dispatch — a packet written to disk, then the bridge called with it"],
  [ACTOR.judge, "the judgment worker — requirements, design, planning, reviews"],
  [ACTOR.worker, "the mechanical worker — codegen, tests, docs"],
];
