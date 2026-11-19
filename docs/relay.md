# Pako Relay: reminders with the lid shut

Pako runs on your own computer, so a reminder due while the laptop sleeps comes when it wakes. The relay fixes that: it is a second Pako,
run by you on a host that stays awake, that keeps your reminders for the week ahead and sends each one on Telegram at its time. It is
optional and off by default.

## How it works

- Your Pako syncs with the relay every two minutes, and again just before it looks at its own due reminders: it sends the reminders of
  the next seven days (each one occurrence, with an id and a version that changes with its text or time) and hears back which the relay
  has sent.
- The relay sends each occurrence once. A reminder you cancel or change on your laptop is simply not in the next sync: the relay drops
  the old one and, for a change, sends the new one.
- When your laptop wakes, its first sync brings back what the relay sent while it slept; those are marked sent and never sent again.
- A host that sleeps is woken by an outside ping: point any cron service at `POST /relay/tick` (with the token) every few minutes.
- A reminder more than 12 hours late is not sent by the relay; your laptop says it was missed when it wakes, as without a relay.

## Set it up

1. A host that stays awake (any small always-on instance; the free tiers that sleep need the cron ping above).
2. On the host, start Pako with `RELAY_TOKEN` (a random secret, 32+ characters: `openssl rand -hex 24`), `RELAY_TELEGRAM_TOKEN` (your own
   bot, from @BotFather) and `RELAY_TELEGRAM_CHAT` (your chat id with that bot).
3. On your own Pako, set `RELAY_URL` (the host's `https://` address) and the same `RELAY_TOKEN`, then restart it.

## What the relay keeps

The text and time of your reminders for the week ahead, which ones it sent in the last 30 days (ids and times only), and the bot token
in its settings. Nothing else. `DELETE /relay/sync` (with the token) wipes it; so does deleting the host.

## Not yet

Pressing a reminder's buttons while the laptop sleeps (Done, +10 min) still waits for the laptop: the relay sends plain messages for now.
