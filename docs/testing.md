# Quality and checks

How Pako's answers are checked against golden cases, and the gate every push goes through.

## How Pako's quality is measured

What Pako says on its own (a follow-up, a reminder, the brief, an email it sends for you) is checked against **golden cases**: small JSON
files in `test/evals/cases/<suite>/`, each an input (the messages, the facts, the owner's words) and the properties the answer must have. The
method is error analysis first, then **one yes/no judge per failure seen**, written as code wherever code can judge. Every judge is
calibrated: next to the good answers, the set holds known-bad ones (`"label": "fail"`), and the gate fails if a judge lets one through.
A judge that always says yes would catch nothing.

| Suite | What it checks |
|---|---|
| `followups` | The follow-up extraction, read through the real engine: the 5:15 AM ET meeting is due at 11:15 in the owner's zone (the fixtures' owner is in Central Europe; 10:15 in the US summer-time week), a re-ping joins the open loop, a cancellation closes it, a moved time moves it, an FYI or someone else's request makes nothing, a hostile message orders nothing, no invented person |
| `nudges` | Timeliness, against a fake clock: each reminder in its window with its words, nothing in the quiet hours, nothing before the delay, nothing once its time has passed, nothing for what was cancelled or done |
| `brief` | Every item cites a fact it was given, every bare time written is a time of a fact in the owner's zone, no person the facts never named, an agreed meeting is never shown confirmed, a hostile Slack message never reaches the page |
| `autonomy` | Provenance: the owner's own request goes without a card; a recipient, number, address or text from an email or Slack, two matching contacts, or Pako's own initiative always ask |
| `memory` | Dated facts through the real door: a moved meeting closes the old day (kept as history), two values that hold together both stay, the computer away or a silent judge lets the newest win, a fact from someone else's email is never kept; "what do you know about X?" shows the person card with what holds now and what changed |
| `jobs` | The brief on the durable jobs' clock with a laptop that sleeps: late with its note until 11:00, skipped after (BRIEF says so once), a hosted server silent as before, and the line for what changed in the memory told since the last brief given, so a skipped day is not lost (code only) |
| `redflags` | The emergency number first, in the language of the words, for the country; figures of speech are not emergencies |
| `intents` | Plain words open the right view; requests and greetings go to Claude |

**In the gate** (`npm run gate`, `test/evals.test.ts`): each case with the model's answer **recorded** in it, judged by the same
validators and decisions the server runs. No Claude, no network, no cost: a change to a validator, a prompt's parser or the clock that breaks
a case fails the push.

**Live** (`npm run evals:live`, never in the gate): the same cases through the real `claude -p` on your plan, with the system prompts the
bridge uses and no tools. Each case runs k times (`--k 3` by default) and passes only if **every** run passes (pass^k: consistency, not one
lucky answer). The code judges decide first; a case's `rubric` (a yes/no question for an LLM judge) is asked only for what code cannot judge,
and only when every code check passed. It shows the number of runs and the estimated cost and asks before starting; `--max-usd` (5 by
default) stops it once spent. Options: `--suite followups`, `--case rohan`, `--model`, `--yes`. The report goes to `.claude/evals/<date>.md`.

**From your feedback** (`npm run evals:from-feedback`): every 👎 on a reminder or a brief item and every **Not mine** from the last 30 days
(`--days`) becomes a draft case in `.claude/evals/drafts/`, with names, addresses, phone numbers, links and channels replaced by placeholders
(`<person1>`, `<email1>`). What Pako did is recorded as the known-bad answer, and what you said is the expectation. Pako never kept the
message itself, so each draft says TODO where you write it again without personal data. Read the draft, then move it into
`test/evals/cases/<suite>/` to approve it into the golden set. It only reads Pako's file (`--home`, `~/.pako` by default) and never changes
it.

**The chat turn, live** (`npm run eval:live`, never in the gate; [eval/README.md](../eval/README.md)): about 30 cases of the owner's own
messages (reminders and time zones, notes, drafting versus sending, injected emails, invites and forwards, language, tasks, refusals,
ambiguous asks) through the bridge's real code and `claude -p`, k times each, with binary code checks on the tags the bridge read and a
yes/no judge only where code cannot decide. `npm run eval:promote` turns a 👎, a **Not mine** or a chat message into a draft case.

## Checks before every push

```bash
(cd voice-worker && npm ci)   # once: the phone voice is its own package
npm run gate                  # both type checks and every test (bin/gate.sh)
```

GitHub's checks do not run for this repository, so the gate runs on your computer instead:

- **Before every push.** Turn it on once per clone with `git config core.hooksPath .githooks`. A failing gate blocks the push and
  shows the failing tests. `PAKO_SKIP_GATE=1 git push` skips it for one push.
- **Every night.** `npm run nightly-install` runs `bin/nightly-gate.sh` at 03:30 each day, on the default branch as it is on GitHub, in a
  throwaway copy. Logs are kept in `~/Library/Logs/pako-nightly/` (the last 14), and a macOS notification appears only when something
  fails. `sh bin/nightly-install.sh --remove` turns it off.
