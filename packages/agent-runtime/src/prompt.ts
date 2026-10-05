/**
 * Prompt text every runtime gives a seat, and that no backend should word differently.
 *
 * The output-voice rules live with the briefing (`withOutputVoice` in core's context module). These two are the runtime's
 * own: what a seat is told about reading, which rides in the cached system prefix, and what it is told when it tries to end
 * a turn without having spoken to the mesh at all.
 */

/**
 * What a seat is told, once, when it is about to end a turn having called no mesh tool.
 *
 * The seventeenth cronlite run lost turns this way: after a `kill -9` and a restart, the developer's and QA's resumed
 * sessions carried the CLI's record that the `mesh` server had failed ("mesh bus unreachable: fetch failed", written at the
 * moment the host died), believed it, did their work with their own tools and ended each turn with prose that said
 * what they would call ("Now I'll call the mesh operations:"). The mesh saw no ops and discarded the turn: QA's 41.5k
 * tokens of reproductions and the developer's four turns (169k) never reached anyone, and the developer's first mesh call
 * came 11 minutes after the reopen. A fresh session made its calls at once, so the tools were never gone.
 */
export const NO_MESH_CALL_REMINDER =
  "You are ending this turn without having called a single mesh tool, so nothing you did, found or wrote in it has reached anyone: " +
  "text outside a mesh call goes nowhere, and work done in your own checkout counts for nothing until it is reported. " +
  "The mesh is running and your mesh tools work: an earlier notice in this conversation that the mesh server failed or was unreachable " +
  "(\"fetch failed\") described a restart that has ended. Report now, with the tool that fits: mesh_artifact_publish or mesh_commit " +
  "(work you produced), mesh_send or mesh_reply (what you found, or an answer), mesh_approve or mesh_block (a verdict), mesh_task_complete " +
  "(a task you finished). If there is truly nothing to report, call mesh_done.";

/**
 * What a seat is told about reading, appended to the role prompt beside the
 * shared output-voice rules.
 *
 * The measured problem this answers is not any single tool result but their
 * accumulation: over the 2026-09-27 skill-panel run, growth in a turn's prompt
 * was spread over its calls — median +1,285 tokens per call, p90 +5,659, and
 * the top 5% of calls were only 30% of the total — so no bound on one result
 * can reach it. What does reach it is HOW the seat reads: the SDK's own `Read`
 * returned 2.79M characters across 114 calls in that run, an average of 24,485
 * characters per call, and every one of those characters was re-sent with each
 * of the ~20 calls that followed. A seat that reads a range instead of a file
 * pays ~8% of what it was paying.
 *
 * Five lines, and deliberately without numbers a seat cannot act on: it is
 * billed on every turn, and it rides in the cached system prefix, so it is
 * cheap only as long as it is short.
 */
export const READING_DISCIPLINE = `## Reading
Your context is the prompt, and everything you read into it is re-sent with every later call of this turn and every later turn of this session — so read the range you need, not the file that contains it: \`grep -n <pattern> <file> | head -n 30\` to locate, then \`sed -n '<a>,<b>p' <file>\` for the lines.
Never read a file you have already read this session; you still have it.
Do not paste file contents into a message, an artifact or a report — cite the path and line range instead. The reader has the same repository you do.`;

/** {@link READING_DISCIPLINE}, appended to a role prompt the way `withOutputVoice` appends the voice rules. */
export function withReadingDiscipline(rolePrompt: string): string {
  const role = rolePrompt.trim();
  return role.length > 0 ? `${role}\n\n${READING_DISCIPLINE}` : READING_DISCIPLINE;
}
