# Unofficial WhatsApp clients: how they work and what they risk

Researched 2026-11-14 for the owner's WhatsApp assistant (a personal project). Evidence is graded: **[code]** is what I read in the libraries' own source,
**[WhatsApp]** is WhatsApp's own words as quoted by a source, **[blog]** is vendor or press writing I could not check against a primary source.
Nothing here is legal advice.

## Short answer

An unofficial client logs in to a WhatsApp account as one more "linked device" (the same way WhatsApp Web does) and drives it from code. It works,
it gives the assistant a normal WhatsApp account that can message anyone, and it is against WhatsApp's own terms. The cost is that the number it logs
in as can be restricted or banned at any time, with no reliable way back. The second cost is supply chain: fake copies of these libraries exist and
have stolen accounts.

## How they work

Both families make the program a **companion device** of an account that lives on a phone. Nothing is hacked: you pair them like WhatsApp Web
(QR code, or an 8-letter code typed in Linked devices, "Link with phone number instead"). End-to-end encryption then ends **on your computer**, because
the library holds the keys.

**whatsapp-web.js 1.34.8** (npm, updated 2026-11-12) **[code]**
- Starts a real Chromium with Puppeteer and opens `https://web.whatsapp.com/` (`src/util/Constants.js`). The traffic is WhatsApp's own web client code.
- Pins a WhatsApp Web version (`webVersion: '2.3000.1017054665'` by default, with a local cache) and injects scripts that call the web client's internal
  modules (`window.require('WAWebCollections')`, `addAndSendMsgToChat`, ...) to send, read and react. When WhatsApp changes those internals, it breaks until a
  new release.
- The login is the Chromium profile (`LocalAuth` keeps it in `session-<clientId>`). Whoever can read that folder is that account.
- Its README: "it is not guaranteed you will not be blocked by using this method. WhatsApp does not allow bots or unofficial clients on their platform, so this
  shouldn't be considered totally safe."

**Baileys 7.0.0-rc14** (`@whiskeysockets/baileys`, last release 2026-07-29, still a release candidate) **[code]**
- No browser. It opens a WebSocket to `wss://web.whatsapp.com/ws/chat`, does the `Noise_XX_25519_AESGCM_SHA256` handshake, speaks WhatsApp's protobuf
  protocol and implements the Signal end-to-end encryption in JavaScript. It presents itself as a web/desktop companion (`browser: Browsers.macOS('Chrome')`).
- Credentials are files on disk (`useMultiFileAuthState`). The defaults `markOnlineOnConnect: true` and `syncFullHistory: true` are noisy (always "online",
  downloads the history); a careful setup turns them off.
- Its README: the maintainers "do not in any way condone the use of this application in practices that violate the Terms of Service of WhatsApp", and
  discourage "stalkerware, bulk or automated messaging".

Others: Evolution API is a server built around Baileys (it can also use Meta's official API); WAHA and similar tools wrap the same two ideas; the Go
projects (go-whatsapp, whatsmeow) are Baileys-style reimplementations (I did not check their state; go-whatsapp looks abandoned).

## What WhatsApp says

- **[WhatsApp, archived 2021 text]** the Terms of Service bar anyone from accessing or using the Services "directly, indirectly, through automated or
  other means" in unauthorized ways; the UK and EEA versions add unauthorized access and automated account creation. A tracker also lists a clause against
  software that works substantially like WhatsApp's services offered to others without authorization. I read these in summaries and the archived text, not the
  current page.
- **[WhatsApp via press]** it does not support third-party clients, and linking an account to unofficial apps can lead to a temporary or permanent ban. A
  "temporarily banned" notice can mean an unofficial version or scraping.
- Restricted accounts can still talk to chats they already have, but cannot start chats with new contacts, create groups, or **use linked devices**: so a
  restriction also kills the client.
- **[blog, September 2026]** WhatsApp is testing a warning in the Linked devices screen of Android for people connected through unofficial web clients.

## Detection and bans (weak evidence)

- Blogs say WhatsApp can fingerprint protocol behaviour, and that scripts get flagged by: identical messages at speed, a data-centre IP, no typing
  indicators or read receipts, new numbers writing to strangers, several accounts behind one IP. Reports and blocks by recipients are the usual trigger.
- Numbers like "banned within 2 to 8 weeks" and "68% banned within a year" appear in vendor blogs. I could not verify them and treat them as marketing.
- Appeals: sources contradict each other (no appeal vs. 2 to 8 weeks). **No primary documentation found.** Plan as if a ban is permanent.
- I did not find the 14-day "phone must connect" rule or the four-device limit in any source I could read. Check WhatsApp's Help Center before relying on them.

## Risks for this project, in order

1. **The number is lost as a WhatsApp account.** Whichever number the client logs in as: a Zadarma number would be the assistant's own (the owner's
   personal number would not be touched), but a personal number would lose all its chats and groups at once. Never link a personal number.
2. **Supply chain.** In December 2025 the npm package `lotusbail`, a fake fork of Baileys that worked, stole session tokens and silently linked the
   attacker's device (about 56,000 downloads, six months public) ([The Hacker News](https://thehackernews.com/2025/12/fake-whatsapp-api-package-on-npm-steals.html)).
   Other fakes, `@erlanzz/baileys` and `@trashcore/baileys`, subscribe the account to attacker channels. Install only the original packages by exact name and
   pinned version, from a lockfile; look at the phone's Linked devices list now and then.
3. **The session is the account.** The auth folder on the Mac gives full read and send access. Keep it private (mode 700, disk encryption).
4. **Breakage.** Both depend on WhatsApp internals; expect fixes every few weeks. Baileys has been on a release candidate for months.
5. **Friends as the trigger.** An account that writes first to people who did not ask is what gets reported. This design confirms each message, opens with
   a line that says it is the owner's AI assistant, and caps 3 a day per number and 10 a day; that lowers the risk, not to zero.
6. **Privacy.** The assistant reads what friends answer and passes it to the owner; Claude is not shown it. A purely personal use is probably covered by the
   household exemption in EU data law; not checked.
7. **What a ban does not do:** nothing in these sources says a ban of one number reaches the owner's other accounts. Not confirmed either.

## Real cases (GitHub, 2025 to 2026): what people report

All anecdotes: self-reported, no logs, no measurements, and no maintainer or WhatsApp has confirmed a cause in any of them. I read the pages themselves.

- **Baileys [#1869](https://github.com/WhiskeySockets/Baileys/issues/1869)** (opened 2025-10-05, comments to May 2026). One person lost 5 bots in a week, each in about 9 groups; two of
  them had used Baileys for over 3 years without a ban. Others report personal numbers banned, and one says a number "never connected to any bot" was banned. A bot
  that stayed in private chats lasted about a week; another was banned after being added to 3 groups while its server was off. Restrictions ranged from a few
  hours to a permanent ban. One person says 5 clients behind proxies with random delays "seems to work fine".
- **Baileys [#1983](https://github.com/WhiskeySockets/Baileys/issues/1983)** (2025-10-28, open). A business on a server sent template messages to **contacts it had not saved
  and never chatted with**, 15 to 20 a day: two 24-hour restrictions, two 48-hour bans, then a lifetime ban on that number. Others on newer versions say theirs
  still work.
- **Baileys [#2075](https://github.com/WhiskeySockets/Baileys/issues/2075)** (2025-11-17, open). Repeated bans, no details of volume or chat type; a second block within 3
  days after relinking. The "causes" listed in the thread come from a commenter promoting their own package.
- **OpenClaw [#16270](https://github.com/openclaw/openclaw/issues/16270)** (OpenClaw is a popular personal AI assistant built on Baileys; 2026-02-14, closed as "not planned"). One
  account, direct messages only. A crash-looping gateway made "3,500+" connection cycles in about 3 hours; the account was restricted and could not re-link for 72
  hours or more. The link between the loop and the restriction is the reporter's claim, and the issue says an AI agent filed it.
- **A hosting vendor's blog** (operator.io, managed OpenClaw) says risk rises on a data-centre IP and with traffic that looks automated. No data.

Also found: guides for OpenClaw recommend a separate number or a prepaid SIM, and there is an open request for it to use Meta's official Cloud API instead of Baileys.
The only legal action I found is Meta's 2022 suit against distributors of unofficial consumer apps
([WhatsApp v. Rockey Tech HK](https://www.docketalarm.com/cases/California_Northern_District_Court/4--22-cv-05711/WhatsApp_LLC_et_al_v._Rockey_Tech_HK_Ltd._et_al/1/),
alleging malware and account takeovers); I found no letters or suits against whatsapp-web.js, Baileys, WAHA or Evolution API (one search, not exhaustive).
I found **no first-hand account of someone running a low-volume personal assistant for months and saying it was never banned**, nor the opposite.

**What the cases suggest for this project** (a pattern in anecdotes, not a measured rate):
1. The bans cluster around **groups**, **messages to people who never wrote first and are not saved contacts**, **many reconnects**, and **data-centre IPs**. A home connection, one
   account, private chats, a few messages a day and a person confirming each one avoid most of that.
2. The weak spot is this design's own feature: the assistant writing first to a friend is the #1983 pattern (new chat with an unsaved contact). Safer: friends save the
   assistant's number and write to it first; the assistant only answers.
3. Any client we build needs a **circuit breaker**: capped reconnect attempts with growing waits, then stop and tell the owner (the OpenClaw lesson).
4. A number can be restricted for hours or days without being banned for good, and some come back; do not count on it.

## If it is done anyway

A number of its own, never the personal one; registered on a real phone (the primary device) that stays on; one client, on a home connection (not a
server); whatsapp-web.js (a real browser) rather than Baileys; typing indicator and a few seconds' delay before each send; no cold or bulk messages; the
AI line stays; `syncFullHistory` and `markOnlineOnConnect` off if Baileys; exact pinned versions; auth folder private; and a fallback (Meta's test number,
or the `wa.me` link) for the day the number dies.

## The three routes side by side

| | Meta Business API (test number) | Unofficial client on a spare number | `wa.me` link from your own WhatsApp |
|---|---|---|---|
| WhatsApp's terms | Business terms bar personal use and general-purpose AI assistants (since 2026-01-15) | Consumer terms bar unofficial clients | Fine: you press send |
| What is at risk | The Meta test app / business account | The spare number | Nothing |
| Messages friends by itself | Only 5 listed numbers, or a template after 24 h | Anyone, no windows | No |
| Cost | Free on the test number | Free | Free |
| Works today | Yes | Not built | Yes |

## Not verified

Current ToS wording; enforcement against private bots; any survival rate for low-volume personal bots (the cases above are anecdotes); the ban and appeal figures; the 14-day and device-limit rules; the state of the Go libraries; whether
the in-app warning has reached iPhone.

## Sources

[WABetaInfo: warning for unofficial web clients](https://wabetainfo.com/whatsapp-is-testing-a-safety-warning-for-unofficial-web-clients/) ·
[Drag: WhatsApp MCP servers and the ban risk](https://www.dragapp.com/blog/whatsapp-mcp-server/) ·
[Zylos: WhatsApp API and automation 2026](https://zylos.ai/research/2026-01-26-whatsapp-api-automation/) ·
[The Hacker News: fake WhatsApp API package](https://thehackernews.com/2025/12/fake-whatsapp-api-package-on-npm-steals.html) ·
[The Register: poisoned WhatsApp API package](https://www.theregister.com/2025/12/22/whatsapp_npm_package_message_steal/) ·
[WhatsApp Terms of Service](https://www.whatsapp.com/legal/terms-of-service) ·
[WhatsApp Business Terms](https://www.whatsapp.com/legal/business-terms?lang=en) ·
[TechCrunch: general-purpose chatbots barred from the Business API](https://techcrunch.com/2025/10/18/whatssapp-changes-its-terms-to-bar-general-purpose-chatbots-from-its-platform).
The library facts come from reading `whatsapp-web.js@1.34.8` and `@whiskeysockets/baileys@7.0.0-rc14` as published on npm.
