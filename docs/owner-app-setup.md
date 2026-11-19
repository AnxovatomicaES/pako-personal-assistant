# Registering Pako's own apps (project owner, once)

Every connection in Pako is **one button**: the person presses **Connect**, allows Pako on the vendor's own page, and is done. For that, the
project registers one app at each vendor, and every Pako uses it:
- each is a public client: it signs in with PKCE, has no secret that matters, and sends the browser back to the person's own computer;
- a Client ID is not a secret, so it lives in the code, in `src/connect-clients.ts`.

Until an ID is filled in, that card falls back:
- Slack and Zoom: the person's own app, with the steps in [channels.md](channels.md#slack-and-zoom-from-the-panel);
- mail: forwarding, or an app password;
- calendar: the private link.

To try a registration on one computer before committing it, set `PAKO_SLACK_CLIENT_ID`, `PAKO_ZOOM_CLIENT_ID`, `PAKO_MS_CLIENT_ID`,
`PAKO_GOOGLE_CLIENT_ID`, `PAKO_GOOGLE_CLIENT_SECRET` (and `PAKO_GOOGLE_GMAIL=on`) in `~/.pako/.env`. An environment value wins over the
built-in one.

| Vendor | Your time | Waiting for review | Where the ID goes (`src/connect-clients.ts`) |
| --- | --- | --- | --- |
| Microsoft (mail, calendar and Teams) | ~10 min | none for personal accounts; publisher verification optional (days, with a Partner ID) | `MS_CLIENT_ID` |
| Google (calendar; Gmail later) | ~15 min | calendar: Google's verification of a sensitive scope, days to weeks; Gmail: a yearly security assessment (CASA), weeks | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_GMAIL_ALLOWED` |
| Slack | ~10 min | works at once in any workspace; Marketplace listing (for full rate limits) takes weeks | `SLACK_CLIENT_ID`, `SLACK_MARKETPLACE_LISTED` |
| Zoom | ~15 min | until published: only the users you add (beta); Marketplace review, typically weeks | `ZOOM_CLIENT_ID` |

Review times are what the vendors say or what is commonly seen. None of them promises a date.

## 1. Microsoft: one app for mail, calendar and Teams

1. Sign in at [entra.microsoft.com](https://entra.microsoft.com) with the project's account, then go to **Identity** → **Applications** →
   **App registrations** → **New registration**.
2. **Name:** `Pako`.
3. **Supported account types:** **Accounts in any organizational directory (Any Microsoft Entra ID tenant - Multitenant) and personal
   Microsoft accounts (e.g. Skype, Xbox)**.
4. **Redirect URI:** choose **Public client/native (mobile & desktop)**, then type `http://127.0.0.1`. Microsoft ignores the port of a
   loopback address. Pako returns to `http://127.0.0.1:<its port>/connect/microsoft/callback`, so also add that path:
   - **Authentication** → **Add URI** → `http://127.0.0.1/connect/microsoft/callback`.
   - The same for Teams: **Add URI** → `http://127.0.0.1/connect/teams/callback`.
   - If the page refuses the `127.0.0.1` form, open **Manifest** and add
     `{"url": "http://127.0.0.1/connect/microsoft/callback", "type": "InstalledClient"}` (and the same with `/connect/teams/callback`) to
     `replyUrlsWithType`, then **Save**.
5. Press **Register**.
6. **Authentication** → **Advanced settings** → **Allow public client flows**: **Yes** → **Save**. Do not create a client secret: Pako is a
   public client.
7. **API permissions** → **Add a permission** → **Microsoft Graph** → **Delegated permissions**. Tick:
   - `IMAP.AccessAsUser.All`
   - `Calendars.ReadWrite`
   - `offline_access`
   - `openid`
   - `email`
   - For Teams (asked by **Connect Teams**, src/teams.ts):
     - `User.Read`, `profile`, `Chat.Read`, `Calendars.Read`: each person can consent alone, where their company allows it.
     - `ChannelMessage.Read.All`, `Team.ReadBasic.All`, `Channel.ReadBasic.All` (channel @mentions) and `OnlineMeetings.Read`,
       `OnlineMeetingTranscript.Read.All` (meeting transcripts): `ChannelMessage.Read.All` and `OnlineMeetingTranscript.Read.All` always
       need each company's admin. Pako asks for this group only with "Add what my admin approved", and gives the person a request to send.

   Then **Add permissions**. Do not press "Grant admin consent": each person consents for themselves, and each company's admin for theirs.
   Listing a permission here only makes it requestable; nobody gets it until they (or their admin) accept it.
8. **Overview** → copy the **Application (client) ID** (a GUID) into `MS_CLIENT_ID`.
9. Optional, for work accounts in other companies: **Branding & properties** → **Publisher verification**, with a Microsoft AI Cloud Partner
   Program ID.
   - Without it, people see "unverified" on the consent page.
   - Some companies block unverified multi-tenant apps, or need their admin to approve Pako.
   - Personal accounts are not affected.

Since late 2025, Microsoft's default for companies that never changed their consent settings blocks people from consenting alone to
`Chat.Read`, `Calendars.*`, `OnlineMeetings.*` and `IMAP.AccessAsUser.All` for apps like Pako: there, the person's admin approves Pako
once for the company. Publisher verification (step 9) does not lift that block, but without it many companies refuse Pako outright.

Pako asks for the mailbox and the calendar in **one** sign-in. Microsoft gives a token for one resource at a time, so Pako takes the
mailbox's now. The same refresh token later gives the calendar's (for the calendar writes that are coming), with no second consent.

## 2. Google: one desktop client for Calendar (and later Gmail)

1. At [console.cloud.google.com](https://console.cloud.google.com), go to **Select a project** → **New project**: `Pako` → **Create**.
2. **APIs & Services** → **Library**: enable the **Google Calendar API**. Enable the **Gmail API** too if Gmail will be read later.
3. **Google Auth Platform** → **Get started**:
   - **App name:** `Pako`, and the project's support email.
   - **Audience:** **External**.
   - **Contact information:** the project's email.
   - Agree to the policy → **Create**.
4. **Branding:** add the homepage, privacy policy and terms URLs (pako-os.com), and the authorised domain `pako-os.com`.
5. **Data Access** → **Add or remove scopes**:
   - `.../auth/calendar.events` (sensitive)
   - `openid`
   - `.../auth/userinfo.email`
   - for Gmail later, also `https://mail.google.com/` (restricted)

   Then **Update** → **Save**.
6. **Audience** → **Test users**: add the addresses that will try it first (at most 100).
7. **Clients** → **Create client**:
   - **Application type:** **Desktop app**.
   - **Name:** `Pako`.
   - **Create**.

   A desktop client accepts any `http://127.0.0.1:<port>` redirect, so there is nothing to register.
8. Copy the **Client ID** into `GOOGLE_CLIENT_ID` and the **Client secret** into `GOOGLE_CLIENT_SECRET`. Google documents that a desktop
   app's secret is not confidential, and its token endpoint still asks for it.
9. Verification:
   - **While the app is in Testing:** only the test users can connect, and Google ends their sign-in after **7 days**. The card then says
     "Sign in again".
   - **To publish (Audience → Publish app) for a sensitive scope** (Calendar): Google verifies the app. That means a verified domain, the
     privacy policy, a short video of the consent flow, and a written justification. It usually takes **days to a few weeks**. Until it is
     verified, people see "Google hasn't verified this app", and at most 100 users can connect.
   - **Gmail** (`https://mail.google.com/`, restricted) additionally needs a yearly third-party security assessment (CASA), which takes
     **weeks**, at the project's cost. Only then set `GOOGLE_GMAIL_ALLOWED = true`. Until then, Gmail is connected with an app password, and
     the Google button connects the calendar only.

## 3. Slack: the project's app from Pako's manifest

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a manifest**, pick the project's workspace, choose
   **JSON**, and paste:

   ```json
   {
     "display_information": { "name": "Pako", "description": "Your assistant, reading your Slack so nothing promised gets dropped (read only)" },
     "oauth_config": {
       "redirect_urls": ["http://localhost:53682/connect/slack/callback"],
       "scopes": { "user": ["channels:history", "channels:read", "groups:history", "groups:read", "im:history", "im:read",
                            "mpim:history", "mpim:read", "users:read", "search:read"] },
       "pkce_enabled": true
     },
     "settings": { "org_deploy_enabled": false, "socket_mode_enabled": false, "token_rotation_enabled": false }
   }
   ```

   Then **Next** → **Create**.
2. **OAuth & Permissions**:
   - Check that **PKCE** is on (the manifest turns it on). It is one-way: only Slack support can turn it off again.
   - Check the redirect URL: `http://localhost:53682/connect/slack/callback`.
   - Slack's documentation does not say whether it ignores the port of a desktop redirect. So Pako always returns on the fixed port 53682
     (`SLACK_LOOPBACK_PORT`), opening a small listener there for the minutes a sign-in takes.
3. **Manage Distribution**:
   - Complete the checklist ("Remove hard coded information": nothing to remove).
   - Press **Activate Public Distribution**.
   - Any workspace can now press Connect Slack. Workspaces that require app approval send their admin a request; the card says "Your
     workspace admin may need to approve Pako".
4. **Basic Information** → copy the **Client ID** into `SLACK_CLIENT_ID`. Pako needs no Client Secret: the PKCE exchange does not use it.
5. Rate limits:
   - Slack treats a publicly distributed app that is not in the Slack Marketplace as "commercially distributed".
   - Since 2025-05-29 such an app gets **one `conversations.history` call a minute** (15 messages). Pako then reads one DM per look
     (`SLACK_MARKETPLACE_LISTED = false`).
   - To lift that, submit to the Marketplace: **Manage Distribution** → **Submit to Slack Marketplace**, with a privacy policy, support
     page, a short demo video and the scope justifications. Review usually takes a few weeks.
   - Once listed, set `SLACK_MARKETPLACE_LISTED = true`.
6. A person's own app (the card's "Advanced: use your own app") is an internal app with full limits. It stays the better choice for heavy
   Slack users until the listing.

## 4. Zoom: a General app with the public client

1. At [marketplace.zoom.us](https://marketplace.zoom.us), sign in with the project's Zoom account, then **Develop** → **Build App** →
   **General App** → **Create**.
2. **Basic Information**:
   - **App name:** `Pako`.
   - **Select how the app is managed:** **User-managed**.
   - **App Credentials:** turn on **Use Public Client OAuth** (PKCE, no secret), for development and for production.
3. **OAuth Redirect URL** and **OAuth Allow List**: `http://127.0.0.1:53682/connect/zoom/callback`. Zoom ignores the port of a loopback
   address and refuses `localhost`, so Pako's own port works whatever it is.
4. **Scopes** → **Add Scopes**:
   - `meeting:read:list_meetings`
   - `meeting:read:summary`
   - `meeting:read:list_summaries`
   - `cloud_recording:read:list_user_recordings`
   - `cloud_recording:read:list_recording_files`
   - `user:read:user`

   For each one, write the justification Zoom asks for.
5. Copy the **public Client ID** (under Use Public Client OAuth) into `ZOOM_CLIENT_ID`.
6. **Before it is published:**
   - The app authorises only the project's own Zoom account, and the users added under **Beta Test** (up to 100, by email).
   - Anyone else pressing Connect Zoom sees Zoom refuse.
   - The card still shows the button; for them, "Advanced: use your own app" is the way.
7. **Submit for review** (**Submit** in the app's left menu). Zoom asks for:
   - the app's description, logo and screenshots;
   - privacy policy, terms and support URLs;
   - a test plan and a test account;
   - the scope justifications;
   - a security questionnaire.

   Review usually takes **a few weeks**, with back-and-forth. Once published, **Publish** makes it available to every Zoom user. The button
   then works for all.

## After filling them in

- Run `npm run gate`. The tests drive every flow against fake vendors, with the IDs set and without them.
- Then release. The cards turn into one button each as soon as an ID is set, with nothing else to change.
