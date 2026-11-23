// Wires the meeting review, Zoom and Slack: their readers, their watchdog parts and probes, and Slack's Socket Mode handle.

import { builtInClients, SLACK_MARKETPLACE_LISTED } from "../connect-clients.ts";
import { appliedAtStart, writeStored } from "../connections.ts";
import { pakoHome } from "../local.ts";
import { createLog } from "../log.ts";
import { createMeetingReview } from "../meeting-review.ts";
import { slackSightings, zoomSightings } from "../people-graph.ts";
import { mountSlack, mountSlackCheckOnly } from "../slack.ts";
import { createZoom } from "../zoom.ts";
import type { AfterSchedule } from "./context.ts";

const logLessons = createLog("lessons");
const logSlack = createLog("slack");
const logZoom = createLog("zoom");

export function wireMeetings(ctx: AfterSchedule) {
  const {
    app, env, local, uiLang, dog, kv, control, timeZone, givenName, slack, slackRef, zoom, zoomRef, reviewCfg, reviewRef, followupsCfg, followupsRef,
    followupsDoor, lessons, door, feedPeople,
  } = ctx;
  let slackSocket: { start(): void; stop(): void } | undefined;
  if (zoom.config && reviewCfg.config) {
    reviewRef.reviewer = createMeetingReview({
      config: reviewCfg.config, kv, timeZone, control, lang: uiLang, ownerName: givenName,
      enqueue: (m) => door.inbox.add(m), notify: (text) => door.notifyOwner(text),
      annotate: (id, summary) => (zoomRef.reader ? zoomRef.reader.annotate(id, summary) : Promise.resolve(false)),
      // The computer asked for messages in the last three minutes: otherwise Zoom's summary is told at once, as before.
      bridgeAlive: () => Date.now() - door.lastPoll() < 3 * 60_000,
      // What the meeting left with each person, in Pako's dated memory of them: the next prep and the person's card know it.
      remember: (facts) => door.facts.add(facts, Date.now()),
      // A name said in the meeting kept under the person's own name (src/people-graph.ts), so their card and context find it.
      canon: (name: string) => door.peopleGraph.canon(name),
      ...(followupsCfg.config
        ? {
            loops: {
              ingest: (o) => (followupsRef.engine ? followupsRef.engine.ingest(o) : Promise.resolve(0)),
              open: () => (followupsRef.engine ? followupsRef.engine.open() : Promise.resolve([])),
              offer: (o) => followupsDoor.offer(o),
            },
          }
        : {}),
    });
    reviewRef.reviewer.start();
  }
  if (zoom.config) {
    const reviewer = reviewRef.reviewer;
    zoomRef.reader = createZoom({
      config: zoom.config, kv, timeZone, control, lang: uiLang, notify: (text) => door.notifyOwner(text), enqueue: (m) => door.inbox.add(m),
      onSummary: (m) => void followupsDoor.offer({ source: "meeting", ref: m.id, label: m.topic, text: m.summary, at: m.at }),
      ...(reviewer ? { review: { summary: (m) => reviewer.summary(m), transcript: (m) => reviewer.transcript(m) } } : {}),
      health: dog.reporter("zoom"),
      speakers: (names, at) => feedPeople(zoomSightings(names, at)),
      // Zoom's refresh token works once: each new one goes where the panel keeps it, so the next start uses it. One set in a file
      // cannot be changed from here, so that setup stops working at the next restart: said plainly.
      ...(zoom.config.mode === "user"
        ? {
            keepRefresh: (t: string) => {
              if (!local || ((env.ZOOM_REFRESH_TOKEN ?? "").trim() && !appliedAtStart().has("ZOOM_REFRESH_TOKEN"))) {
                logZoom.error("Zoom gave a new refresh token, but ZOOM_REFRESH_TOKEN is set outside the panel: connect Zoom from the panel instead");
                return;
              }
              if (!writeStored(pakoHome(env), { ZOOM_REFRESH_TOKEN: t })) logZoom.error("could not keep Zoom's new refresh token");
            },
          }
        : {}),
    });
    zoomRef.reader.start();
    dog.watch("zoom");
    logZoom.info(`ON: ${zoom.config.mode === "user" ? "your own app" : zoom.config.user}, listed every ${zoom.config.pollMinutes} min`);
  }
  if (slack.config) {
    slackRef.reader = mountSlack(app, {
      config: slack.config, kv, timeZone, control, lang: uiLang, notify: (text) => door.notifyOwner(text),
      observe: (m) => {
        void followupsRef.engine?.observeSlack(m);
        // The owner's own post beside a draft Pako wrote for that conversation: what they changed is learnt (src/lessons.ts).
        if (m.mine) void lessons.ownSent({ channel: m.channel, ...(m.thread ? { thread: m.thread } : {}), text: m.text, at: m.at }).catch((err: Error) => logLessons.error(err.message));
        // The owner's own message is not a sighting of someone else.
        if (!m.mine) feedPeople(slackSightings(m));
      },
      health: dog.reporter("slack"),
      eventsHealth: dog.reporter("slackEvents"),
      // Connected with the project's own app, not yet in the Slack Marketplace: one DM a look, and one conversation read a minute for the
      // poll and the follow-ups together (Slack's limit for such apps, src/slack-gate.ts).
      ...(!SLACK_MARKETPLACE_LISTED && (env.SLACK_CLIENT_ID ?? "").trim() && (env.SLACK_CLIENT_ID ?? "").trim() === builtInClients(env).slack
        ? { pollPerRound: 1, historyPerMinute: 1 }
        : {}),
    });
    dog.watch("slack");
    if (slack.config.appToken) dog.watch("slackEvents");
    // Slack brings its news by itself: a token revoked on a quiet day is found by a look every half hour.
    const slackReader = slackRef.reader;
    dog.probe(30 * 60_000, () => slackReader.check());
    // Socket Mode (SLACK_APP_TOKEN): opened once the server listens, closed on shutdown (src/app/services.ts); the events address works
    // beside it when the signing secret is set too (each event is handled once, by its id).
    if (slackRef.reader.socket) slackSocket = slackRef.reader.socket;
    // Neither live way set up (what connecting from the panel gives): Pako looks every minute (src/slack-poll.ts).
    slackRef.reader.poll?.start();
    const ways = [slack.config.appToken ? "Socket Mode" : "", slack.config.signingSecret ? "events at /slack/events" : ""].filter(Boolean).join(" + ")
      || "a look every minute";
    logSlack.info(`ON: ${ways}, quiet ${slack.config.quiet ? env.SLACK_QUIET_HOURS ?? "23:00-08:00" : "off"}`);
  } else {
    mountSlackCheckOnly(app);
  }
  return { slackSocket };
}
