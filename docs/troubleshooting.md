# When something does not work

What to do when Pako does not start or answer, and how Pako tells you when one of its parts breaks. For Windows, see also [install-windows.md](install-windows.md#if-something-goes-wrong).

## If something does not work

- **Old Node, or `npm install` not run.** `npm start` checks both first and says what to do.
- **No Claude Code yet.** Pako still starts, and the chat says what to install. It notices when you do.
- **Claude not signed in, or out of its limit.** The chat says so. Your message waits and is answered once Claude works again.
- **Claude Code updated itself and something changed.** Pako tests each new Claude Code version by itself (a few seconds, no usage). If
  one fails, Pako keeps answering with what still works, and the Health card says what failed with the one command that goes back to
  the last version that passed, such as `npm i -g @anthropic-ai/claude-code@2.1.327` (or `claude install 2.1.327`).
- **The sign-in link expired, or you closed the tab.** The link works once, for 10 minutes. Run `npm run panel` in the Pako folder for a new one.
  No restart is needed. A signed-in browser stays signed in for 30 days.
- **Port 8787 is taken.** `PORT=8788 npm start`.

## Pako tells you when something breaks

Pako must never go quiet without you knowing why. Every moving part says how each of its rounds went, and the watchdog (`src/watchdog.ts`)
tells you **once** per incident, on the chat that still works (Telegram when it is paired, else WhatsApp, else the panel's chat, which the Mac
app turns into a notification), with what failed, since when, and the one thing to do. When the part works again, one line says so.

| Part | Counts as down when |
| --- | --- |
| The assistant's computer (a server only) | it has not asked for messages for 15 minutes |
| Claude | it has been signed out (or missing, or not starting) for 15 minutes; its usage limit is not an outage |
| The data store | a second write fails a minute or more after the first with none good between, or nothing good comes for 10 minutes after a failed one (the server's store, or `~/.pako/kv.json` on a computer); one dropped write is a blip |
| WhatsApp, Telegram | 3 sends or polls in a row fail for a reason that is theirs (a refused token, the service down), over 5 minutes at least; on a computer, WhatsApp's webhook: Meta refusing the tunnel's address 3 times over 5 minutes (Pako keeps trying every ten minutes) |
| Calendar, mail (AgentMail, IMAP), Slack, Zoom | 3 rounds in a row fail, over 5 minutes at least (Slack is also checked every half hour, as it brings its news by itself) |
| The assistant computer's version (a server only) | it runs a version more than a day older than the server's |

Your quiet hours (`WATCHDOG_QUIET_HOURS`, by default `SLACK_QUIET_HOURS`, else 23:00-08:00) hold the notices until they end, except for the
computer and the store, without which Pako cannot answer or keep anything; a part that is back by the morning is not mentioned at all. A
restart neither repeats an incident nor forgets to say it is over (they are kept in the store). A part that fails again within six hours of
its recovery being said shows on the panel at once but is told only if it lasts (30 minutes; 10 for the computer and the store), so a
flapping part does not send a message each time. The panel's **System** card shows every
part, what is failing and since when, and the version the assistant's computer runs; next to it, **Quality** and **Rehearsal** say how useful
Pako is. On the chat, "how is Pako doing?" (or `HEALTH`) gives the same in words. `WATCHDOG=off` turns the notices off.

With Slack's events coming by Socket Mode (`SLACK_APP_TOKEN`), that connection is a part of its own ("Slack's connection for new messages"):
a refused app token or Socket Mode switched off in the Slack app counts as a failed round each time it is tried (every ten minutes), so it is
told after half an hour, with that token as the thing to check. A search that works with the user token never closes it, and a Socket Mode
hello never closes an incident of the user token.
