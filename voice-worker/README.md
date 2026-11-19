# Voice worker

The personal caller's own voice stack. A LiveKit agent that rings the owner through the owner's SIP number (Zadarma) and
talks with a realtime speech model (Gemini Live): no speech-to-text, thinking and voice hand-offs in between, and it runs on a
European server instead of Retell's.

The main server (`src/personal-caller.ts`, engine `livekit`) decides whether a call may happen: caps, the owner's number, the
opening line that says it is an AI, the owner-name lock. It then asks LiveKit to start this worker with the call's details as
job metadata. The worker dials the number it is handed, says the opening it is handed, talks, hangs up, and posts the result
(transcript, answer speed, whether the first words said it is an AI) to `POST /personal-voice/result` on the main server,
signed with the LiveKit API secret.

Calls to friends do not use it: they stay on the Retell agent until the AI line of this stack has been checked in real
transcripts (`disclosed_ai` in the result).

## Run on Render (a web service, region Frankfurt)

- Build: `cd voice-worker && npm install && npm run build`. Start: `cd voice-worker && npm start`.
- On a free plan the service sleeps after 15 minutes without a visit. The main server visits `VOICE_WORKER_URL` first (the worker
  answers 200 only once it is connected to LiveKit), so the first call after a pause rings after about a minute. A free instance
  has little CPU: if the audio stutters, a paid plan fixes it, nothing in the code changes.
- Environment (set by the owner on the service's Environment page; the code never holds them):

| Variable | What |
|---|---|
| `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | the LiveKit Cloud project |
| `GOOGLE_API_KEY` | Gemini API key |
| `SIP_USERNAME`, `SIP_PASSWORD` | the Zadarma SIP account |
| `SIP_NUMBER` | the number shown to the person called, E.164 (`+44...`) |
| `SIP_ADDRESS` | default `sip.zadarma.com` |
| `SIP_COUNTRY` | default `ES`: calls leave LiveKit from a server in that country |
| `PAKO_URL` | the main server's address, for the result post (a worker set up before Pako had its name may have it as `AI_BUYER_URL`, which still works) |
| `GEMINI_LIVE_MODEL`, `GEMINI_VOICE`, `GEMINI_SILENCE_MS` | optional; the main server sends its own model and voice with each call |

More settings (all optional; the first column is the exact name):

| Variable | What |
|---|---|
| `VOICE_RESULT_SECRET` | signs the result post (default `LIVEKIT_API_SECRET`); needed when LiveKit Cloud hosts the worker, because the secret it injects is the project's own |
| `GEMINI_START_SENSITIVITY`, `GEMINI_END_SENSITIVITY` | how readily the model hears the start and the end of the person's speech |
| `VOICE_CARRY_ON_MS`, `VOICE_OPENING_DELAY_MS` | wait for a reply after the opening (default 1500) and the pause before it (default 0) |
| `VOICE_IDLE_PROCESSES` | standby processes kept loaded (default 0) |
| `LIVEKIT_WORKER_TOKEN` | LiveKit's own token for this worker's registration, when your LiveKit project gives one (usually not needed) |
| `LOG_LEVEL` | the agent's log level (`info` by default) |

The main server needs `LIVEKIT_URL`, `LIVEKIT_API_KEY` and `LIVEKIT_API_SECRET` too (the same values).

Optional agent settings: `VOICE_SEARCH=1` gives the live voice Gemini's own Google Search for quick facts (off by default: not
tested with every live model; the back office below searches the web anyway). `VOICE_AFFECTIVE=1` turns on Gemini's affective dialog.

## Sessions on the owner's line

- **The server rings the owner** (`call_me`). With a message, the assistant says it and follows the owner's lead. Without one,
  it is an open conversation: no agenda, up to 20 minutes, older audio compressed away on long calls.
- **The owner rings the assistant** (inbound). Set it up once with `npm run inbound:setup` (see `scripts/setup-inbound.ts`).
  That creates an inbound trunk that only takes the owner's number, and a dispatch rule that sends each call to this agent,
  optionally behind a keypad PIN (`VOICE_INBOUND_PIN`). Then forward the Zadarma number to the LiveKit SIP URI. The worker asks
  the main server (`POST /personal-voice/inbound`) whether to take the call and with what instructions (a sleeping main server is
  waited for, up to about a minute). Caller ID can be faked, so a call without the PIN is not verified: it can talk and search the
  web, and nothing else. It sees no notes, cannot list contacts, ring anyone, check calls or save anything, and is never summarised
  into the memory. At most 30 inbound calls a day (shared: without a PIN the server cannot tell the owner from a faked caller ID, so
  set `VOICE_INBOUND_PIN`), and 40 tool calls per call. Tool calls have a daily budget of 300 for verified calls and a separate 60 for unverified ones.
- **The browser voice lab** (`/admin/voice-lab` on the main server, behind the admin key). The same agent over WebRTC with
  wide-band audio, a voice picker and a live transcript: it separates the voice from the phone line.

**The voice's tools.** There is no second AI and no Anthropic key: the live voice (Gemini) chooses the tool, and each one does exactly what it says.
- `look_up` runs in this worker: Gemini text with Google Search, using the same Google key as the voice. It takes a few seconds, so it runs in
  the background and the answer comes back as a new turn while the person keeps talking. The model is found by listing what the key can use (the
  newest plain "flash"; `GEMINI_TEXT_MODEL` overrides it), and `OWNER_PLACE` / `OWNER_TIME_ZONE` tell it where the person is. The answer is passed
  to the voice as information, never as instructions.
- `list_contacts`, `call_contact`, `confirm_call`, `check_call`, `remember` and `forget` are run by the main server (`POST /personal-voice/tool`,
  signed under its own key, timestamped, one-time, tied to a live call by a per-call token), only on a verified call.
- Ringing a friend is only staged by `call_contact`. The server writes the read-back itself and the voice says it word for word, so the owner
  agrees to exactly what is sent. The worker reports a read-back only when it played out to the end (not cut off). `confirm_call` places the call
  only when that exact read-back was reported and everything the owner said after it, joined into one text, is a short answer made of
  yes-words with a real "yes" in them ("of course not", "yes, but wait", a question, a thanks or a request is not one), within a minute.
  That text comes from the live (partial) transcripts, not from the committed transcript lines: with Gemini Live the owner's turn is only
  committed when the model's turn is over, so while a tool runs the owner's last words are not a line yet.
  Tool calls of one call run one at a time, and any confirm attempt uses the staged call up. It places the call the same way as a press on
  the card of the `call_contact` MCP tool: contact list, caps, quiet hours, and it opens with the AI line.
- After each verified call, the worker writes a one-line summary with Gemini and sends it with the result; the main server keeps it in the
  owner memory (its key value store), and the next verified call's prompt includes it. Memory writes are one at a time and fail rather than
  overwrite when the store cannot be read.

## Develop

`npm run typecheck`, `node --test test/*.test.ts` (pure helpers: timing, signature, metadata).
