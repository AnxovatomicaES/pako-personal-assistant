# Commands in the chat

You never need a command: ask in your own words. These are the shortcuts, and the questions Pako answers by itself.

You do not need any of them: **just ask in your own words**, in any language. Claude answers in the language you write in, and it sees
your open loops, your calendar for the week, what is still open from your meetings and today's brief's to-dos, so "what am I forgetting?"
gets a grounded answer however you put it.

The most frequent questions are answered at once by Pako itself, exactly as their command would be, even when Claude is not available
(`src/intents.ts`). The whole message has to be the question; a greeting, "tell me", "please" or "Pako" around it is fine, and so is a
small typo in a long word. These quick answers know English; the same question in another language goes to Claude, which answers it from
the same context:

| You write (for example) | Pako shows |
| --- | --- |
| What am I forgetting? · What's pending? · Any loose ends? | `PENDING` |
| What's on today? · What do I have tomorrow? · My agenda tomorrow | `CALENDAR`, with the day you named |
| Brief me · Give me my daily brief · Today's brief | `BRIEF` |
| Anything on Slack? · Any new Slack messages? | `SLACK` |
| My reminders · What reminders do I have? | `REMINDERS` |
| What came out of my meetings? · Meeting action items | `MEETING TODOS` |
| How is Pako doing? · Is everything working? | `HEALTH` |
| Do a dry run · What would you have told me today? | `REHEARSAL` |

Anything less clear goes to Claude as before: "remind me tomorrow to check what's pending" is a reminder, not the list, and "what came out
of the meeting with Ana?" is a question about one meeting; "how is it going?" without "Pako" is a greeting. A view whose feature is not
connected is Claude's to answer too.

The commands below are shortcuts for the same things. A command is the whole message. Capitals, accents and punctuation do not matter.
Commands are English words; anything else, in any language, goes to Claude.

| Command | What happens |
| --- | --- |
| `HELP` | What Pako does (ask in your own words first), and the shortcuts that are on in your Pako. |
| `STOP` · `PAUSE` | Halts every call and outgoing message, a table request included. Your chat, reminders and mail summaries go on. |
| `RESUME` | Back to normal. |
| `LOG` | The last 15 things Pako did. |
| `UNDO` | Undoes the latest change Pako made by itself (a note, a reminder, a list or a task) in the last 24 hours. Each receipt also has an **Undo** button, good for 7 days. |
| `BRIEF` · `DAILY BRIEF` · `BRIEFING` | Today's brief now (see [Every day](features.md#every-day)). Works while paused. |
| `NOTES` · `MY NOTES` | Your notes, numbered, oldest first, each with its day. |
| `FORGET 3` · `FORGET NOTE 3` · `DELETE NOTE 3` | Deletes note 3. A number never moves to another note. |
| `EDIT 3: text` · `EDIT NOTE 3: text` | Replaces note 3's words; it keeps its number and date. |
| `REMINDERS` | Your pending reminders, repeats marked. |
| `LISTS`, or `LIST` and its name | Your lists, or one. `LIST` with a name that is not a list goes to Claude. |
| `TASKS` | Your open tasks. |
| `PEOPLE` | The people in your life Pako keeps, with their relation. |
| `PERSON Ana` | What Pako keeps about Ana (only when there is an Ana; otherwise the words go to Claude). |
| `PERSON Ana: relation my cousin` (or `birthday`, `likes`, `notes`, `name`) | Changes that part; nothing after it clears it. A receipt with Undo. |
| `FORGET PERSON Ana` | Forgets Ana, and her birthday reminder. A receipt with Undo. |
| `What do you know about Rohan?` | Rohan's card: the names and identities Pako has seen (mail, Slack, calendar, Zoom), the dated facts that hold now, what changed lately, the last contacts; then a waiting "same person?" question with Yes / No buttons. Someone unknown goes to Claude. |
| `ROUTINES` | Your routines, numbered. |
| `WATCHES` | Your watches, numbered. |
| `DELETE ROUTINE 2` · `PAUSE ROUTINE 2` · `RESUME ROUTINE 2` (and `WATCH`) | Deletes, pauses or restarts one by its number, which never moves. |
| `PANEL` | A one-time link to the control panel. |
| `TELEGRAM` | A one-time link (10 minutes) that pairs your Telegram account. On a computer with no bot yet, it points you to the panel's Telegram card. |
| `TELEGRAM OFF` · `TELEGRAM DISCONNECT` | Unpairs your Telegram account. |
| `MAIL` · `INBOX` | The last 24 hours of mail: told, kept, mass mail by sender. Needs the mail inbox. |
| `CODE` | The one-time codes from the last 30 minutes of mail, hidden everywhere else. Needs the mail inbox. |
| `CALENDAR` · `AGENDA`, with `TODAY` or `TOMORROW` | Today and tomorrow, or one day, overlaps marked. Needs a calendar (ICS link or Zoho). |
| `ZOOM` · `MEETINGS` | The coming meetings and the latest summaries. Needs Zoom. |
| `BOOKINGS` | The tables Pako asked a restaurant for, or handed you a link for. Needs table booking. |
| `SLACK` | Slack messages for you in the last 24 hours. Needs Slack. |
| `PENDING` · `OPEN` · `OPEN LOOPS` | What you were asked or promised that Pako does not see done yet, newest first, each with where it came from. Needs follow-ups (on by default with Slack, mail or Zoom). |
| `DRAFT` · `DRAFT` and a few words | The message that closes a follow-up, written for you to copy and send yourself: right after a reminder, for that one; with words (`DRAFT contract`), for the one they name. Nothing is sent. Needs follow-ups and the written brief. |
| `MEETING TODOS` | What is still open from the last 7 days of Zoom meetings, by meeting, with the open questions. Needs Zoom. |
| `HEALTH` · `STATUS` | How Pako is doing, in words: what is down and the one thing to do, what has been failing for a little while, what has not been heard from yet, and what works (the panel's **System** card), then the last 7 days of the **Quality** card in one line. Answered while paused too. |
| `REHEARSAL` · `REHEARSE` · `DRY RUN` | A dry run: the follow-ups read over the last 48 h of what Pako already keeps (Slack, mail summaries, meeting summaries) and today's written brief. The panel's **Rehearsal** card shows what Pako WOULD have said: each would-be reminder with its source and what its check found. Nothing is sent, nothing changes. Also a button on the card. |
| `MY HEALTH` | Your health diary of the last 14 days and the medication you told Pako, on this computer only. |
| `log: slept 5 hours` (sleep, mood, symptoms, exercise, water) | One note in your health diary, in your words. |
| `DOCTOR SUMMARY` | What you logged in the last 30 days, by kind, to show your doctor. Not a diagnosis. |
| `how am I sleeping?` · `MY SLEEP` | Your own sleep notes of the last two weeks and, when they give hours, the average. Not a diagnosis. |
| `FORGET MY HEALTH`, then `FORGET MY HEALTH CONFIRM` | Deletes the health diary and the health and mood Pako picked up in conversation. Asked twice. |
| `don't talk to me about food` · `talk to me about travel` | Turns a topic of what Pako says on its own off or on (suggestions, habit nudges, quiz cards, birthdays). |
| `I want to learn Italian` | Keeps a learning goal; Claude starts a short lesson. |
| `QUIZ ME` (or `QUIZ ME ON Italian`) | The next review card that is due; your next short message is the answer. |
| `MY PROGRESS` | Your learning goals: cards, due today, how many right. |
| `STOP LEARNING Italian` | Pauses a goal; its cards stay. |
| `TURN ON THE CHECK-IN` · `TURN OFF THE CHECK-IN` | A light weekly "how was your week?", off by default. |
| Anything else | Claude answers: questions, web search, notes, reminders, lists, tasks, people, routines, watches, proposed calls, tables. |

The commands are answered by the server, at once, even when Claude is not available. A command whose feature is not connected is not a command:
its word goes to Claude like any other message.

Cards carry buttons: **Call**, **Send**, **Cancel**, **Undo**, and on a reminder **Done**, **+10 min**, **Tomorrow**. A typed `yes`
(`ok`, `sure`, `go ahead`, `do it`…) or `no` as your very next message answers a call, message or table card too, except a call that Claude asked for through the connector, which needs the button.
