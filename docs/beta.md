# Pako beta: two weeks on your real work

Pako is in beta. Its one job is that nothing you promised, or were promised, gets dropped. The only way to know whether it does that is
for people to run it on their real Slack, mail and meetings. Thank you for being one of them.

## Who we're looking for

- **Two weeks.** Pako needs a few days to settle in, and one week's numbers are too few to say much.
- **Your real work account**, the Slack, mail and calendar you actually use, not a test workspace: the misses that matter only happen in
  real conversations.
- **macOS or Linux.** (Windows works, but the beta's numbers come from macOS and Linux for now.)
- **A Claude plan** (Pro, Max, Team or Enterprise), or an Anthropic API key. Pako's reading runs on your own computer through it.
- About two minutes a week for the questions below, if you opt in to them.

## What to do

1. **Install and connect** what you really use: Slack, your mail (IMAP), your calendar, Zoom or Teams. See the README.
2. **Turn on the weekly check:** in the panel, Settings → *How Pako acts* → **Beta: help measure Pako**. (Optional, but it is what makes
   your two weeks count; see below.)
3. **Live with it for 14 days.** Read the morning brief, answer the reminders: Done, In 1 h, or Not mine.
4. **Tell Pako when it gets something wrong, in the chat:**
   - It missed a promise: `you missed send Omar the signed NDA by Friday`. It is counted as a miss and put on your open list.
   - It closed something that isn't done (each morning brief lists what Pako closed for you, and why): `reopen NDA`.
   - A reminder that isn't yours: press **Not mine**. One that wasn't useful: 👎.
5. **After the two weeks, run the report** and send it (see *Sending your numbers*).

## The weekly check ("Beta: help measure Pako")

Telling Pako "you missed …" only counts the misses you happen to notice, and you rarely notice something that was never shown to you. So
the beta measures instead: once a week, Pako picks a small random sample of what it read that week and asks you about it.

**What it asks**, one question at a time in your chat with Pako, each answered with one tap:

- About **8 conversations where it found no promise**: it shows where it was (Slack, email, a meeting), who was in it and its first two
  lines, and asks *"Was there a promise here, by you or to you?"* **Yes / No / Skip.** Skip whenever you're not sure or would rather not.
- About **2 follow-ups it made**: *"Was this a real promise?"* **Yes / No.**
- About **2 follow-ups it closed on its own**: *"Was closing it right?"* **Yes / No.**

**How often:** once a week, 12 questions at most. The next question comes right after you answer one. Never in your quiet hours. If a
question sits unanswered for 12 hours it is skipped, and after two unanswered in a row Pako stops asking until next week. You can turn the
check off at any time in the same place; turning it off deletes every line it kept.

**What it gives:** your answers turn into three numbers with honest error bars (90% intervals), overall and for mail, Slack, meetings and
chat:

- **Catch rate (recall):** of all the real promises, how many Pako caught. The misses are estimated from the conversations you said had a
  promise, plus the ones you told Pako about.
- **Precision:** of the follow-ups Pako made, how many were real promises.
- **Auto-close accuracy:** of what Pako closed on its own, how many it was right to close (your reopens count as wrong).

The sample is random and weighted (a question about a busy source stands for more conversations than one about a quiet source), so a dozen
answers a week are enough to see where Pako stands, and the error bars say how sure that is.

## Sending your numbers

**With the Mac app (no terminal):** in the panel, Settings → *How Pako acts* → **Beta: help measure Pako** → **Show my beta report**.
It shows everything the file holds; **Save it as a file** puts `pako-beta-<date>.json` in your Downloads. That is the same file as the
command below.

**From a terminal:**

```bash
npm run beta:report -- --days 14
```

prints the report: counts and, with the weekly check on, the measured numbers. No titles, names, addresses, subjects or messages: only
numbers.

To send it, make the export:

```bash
npm run beta:report -- --days 14 --export
```

It prints **everything** the file will hold, exactly as it will be written, and asks before writing `pako-beta-<date>.json` in the
current folder (add `--yes` to skip the question, or give a file name after `--export`). The file holds:

- the report's counts (follow-ups made by source and kind, closes, reopens, misses you told Pako about, reminders and their answers,
  👍/👎);
- the weekly check's answers as counts per week, source and kind: how many there were (N), how many you answered Yes or No (n) and how
  many were Yes;
- how many questions were asked, answered, skipped and left unanswered;
- the date, the number of days, and a random id made on your computer (so your file is counted once if you send it twice; it says
  nothing about who you are).

Nothing else: no message, no name, no address, no subject, no title. Read it, then send it to the Pako team by email or attach it to a GitHub
issue (title: "Beta report") if you want to. Pako never sends it, or anything else, on its own.

The team pools everyone's files with `npm run beta:combine -- a.json b.json …` into one catch rate, precision and auto-close accuracy, with
intervals, overall and by source.

## What we measure

- **Catch rate:** the goal is that nothing promised gets dropped.
- **Precision:** a follow-up that wasn't a promise is noise.
- **Auto-close accuracy:** a wrong close is worse than an extra reminder.
- **Not mine and 👎:** reminders that didn't help.

## Privacy

Everything stays on your computer (`~/.pako`). With the weekly check on, Pako keeps the first two lines of each conversation it read for 8
days, only so a question can show them to you in your own chat with Pako; they go once the question is answered or its week is over. Your
answers are kept as counts. The export above is the only thing you ever send, and you read it before you send it. Pako has no telemetry.
See `docs/privacy.md`.

## Known rough edges

- The Mac app isn't notarized yet, so macOS asks you to allow it once (see the README's install steps).
- Gmail, Outlook and iCloud mail need an app password for now (the connection page walks you through it).
- It needs a paid Claude plan (Pro, Max, Team or Enterprise), or an API key. The demo week shows Pako on invented data.
