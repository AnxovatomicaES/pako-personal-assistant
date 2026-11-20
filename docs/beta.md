# Pako beta: one week on your real work

Pako is in beta. Its one job is that nothing you promised, or were promised, gets dropped. The only way to know whether it does that is
for people to run it on their real Slack, mail and meetings for a week. Thank you for being one of them.

## What to do

1. **Install and connect** what you really use: Slack, your mail (IMAP), your calendar, Zoom or Teams. See the README.
2. **Live with it for 7 days.** Read the morning brief, answer the reminders: Done, In 1 h, or Not mine.
3. **Tell Pako when it gets something wrong, in the chat:**
   - It missed a promise: `you missed send Omar the signed NDA by Friday`. It is counted as a miss and put on your open list.
   - It closed something that isn't done (each morning brief lists what Pako closed for you, and why): `reopen NDA`.
   - A reminder that isn't yours: press **Not mine**. One that wasn't useful: 👎.
4. **After the week, run the report** and paste it into a GitHub issue (title: "Beta report"):

   ```bash
   npm run beta:report
   ```

   It prints counts only: how many follow-ups were made, how many Pako missed, how many it closed that you reopened, and how the reminders
   went. No titles, names or messages. Add anything in your own words if you like.

## What we measure

- **Missed:** promises Pako never caught. The goal is zero.
- **Reopened:** things Pako closed on its own that weren't done. The goal is zero. A wrong close is worse than an extra reminder.
- **Not mine and 👎:** reminders that didn't help.

## Privacy

Everything stays on your computer (`~/.pako`). The report is the only thing you send, and you read it before you send it. Pako has no
telemetry.

## Known rough edges

- The Mac app isn't notarized yet, so macOS asks you to allow it once (see the README's install steps).
- Gmail, Outlook and iCloud mail need an app password for now (the connection page walks you through it).
- It needs a paid Claude plan (Pro, Max, Team or Enterprise), or an API key. The demo week shows Pako on invented data.
