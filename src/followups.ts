// Follow-ups: the commitments engine. What other people asked of the owner, what the owner promised, meetings agreed and deadlines, found in
// the owner's Slack (the messages kept for them), in their email (the real words, src/mail-followups.ts), and in meeting outcomes; checked
// later; and the owner reminded once,
// only when the check finds it not done.
//
// - Extraction never runs here: each conversation's new messages (gathered for a few minutes), with its last messages and the owner's own
//   replies, go to the assistant's computer as an inbox job of its own (`followup`), which reads them in an ISOLATED run (assistant/bridge.ts
//   handleFollowup, FOLLOWUP_PROMPT: no tools, no conversation, no tags) and posts back strict JSON (POST /assistant/followups). The server
//   takes it field by field: kinds and checks from fixed lists, every text neutralised and cut (src/quarantine.ts), times it can read, at most
//   three loops a job, and the channel to look at is the conversation's own, never one the text names. Nothing the model writes decides WHEN
//   the owner is told or HOW OFTEN: that is this file's clock and budget.
// - The check, FOLLOWUP_DELAY_MIN after the words were said (10 by default): the owner's Zoom (a meeting near that time, or whose topic names
//   those people), the calendar, the owner's own posts in that Slack conversation after the ask (a reply, or a Zoom link). Mail that went out
//   cannot be seen: the nudge says so. Done: closed silently (the log only). Not done: ONE nudge with what was checked, and its buttons
//   (Done / In 1 h / Not mine); one more near the deadline after a fresh check; never over FOLLOWUP_MAX_PER_DAY, never in the quiet hours,
//   never once its time has passed. After the nudge it is still looked at, silently, so it can close by itself. Someone else's promise is
//   looked at once, near its time (their invitation on the calendar). A later message of the conversation can close a loop (`closes`).
// - "Not mine" keeps a short rule that the next extraction is given, and that this file applies itself to the same person and place.
// - A follow-up never ACTS: it never posts, schedules or writes anywhere; it reminds.
// - An older bridge lets a `followup` job go unread (its text is empty): no loops, no nudges, nothing else changes.
//
// One key in the store (FOLLOWUPS_KEY), written one change at a time, never from a copy that could not be read.

export { FOLLOWUPS_KEY } from "./followups/store.ts";
export { LOOPS_MAX, FOLLOWUP_BUTTON, jobInboxId } from "./followups/limits.ts";
export { LOOP_KINDS } from "./followups/types.ts";
export type {
  LoopKind, LoopStatus, SourceKind, Where, Check, LoopSource, Loop, LearnedRule, Job, FollowupsState, FollowupsConfig, SlackSeen, SlackLine,
  ZoomSeen, EventSeen, FollowupsDeps, CardFeedback, FollowupsQuality, DraftInput, WouldBe, DryOutcome, FollowupsDoor, MailSeen, MailBatch,
} from "./followups/types.ts";
export { loadFollowupsConfig } from "./followups/config.ts";
export { zoneOf, zoneName, zonedTime } from "./followups/time.ts";
export { loopOf, jobOf, stateOf, loopsOf } from "./followups/record.ts";
export { clean, parseExtraction, parseAnswer } from "./followups/answer.ts";
export { createFollowups, type Followups } from "./followups/engine.ts";
export { followupsProxy, PROXIED } from "./followups/door-proxy.ts";
