#!/bin/sh
# The time-sensitive suites again under two more time zones (docs/testing.md): npm test runs everything under Europe/Madrid, and no test may
# lean on that. Los Angeles is behind UTC with US daylight-saving dates; Kolkata is ahead of it by a half hour, with no daylight saving.
# A test about "this computer's own zone" sets the zone it means (test/helpers/zone.ts withSystemZone). Run from the repository's root.
set -e
FILES="autonomy brief-day-shape brief-later-and-overlaps brief-people brief-support brief-us-clock brief-v2 brief calendar-changes calendar-local
  calendar-sources calendar-writes calendar companion door-late-answers evals followups-close-chat followups-door-proxy followups-draft-send
  followups-drafts followups-loop-lifetime followups-loops followups-matching followups-own-promises followups-rehearse-rules followups
  gentle-checkins gentle-robust gentle google-calendar held-action-after-sleep i18n-door i18n-modules i18n ics jobs-claim-atomic jobs lock-start-time-zone-free
  mac-calendar-feed meeting-agreements meeting-prep memory-time-and-people panel-agenda-days panel-i18n personal-caller proactive region
  routine-same-hour-other-day routine-weekday-first-on-weekend routines tasks together undo zoom-review"
PATHS=""
for f in $FILES; do PATHS="$PATHS test/$f.test.ts"; done
for zone in ${PAKO_TEST_ZONES:-America/Los_Angeles Asia/Kolkata}; do
  echo "# time-sensitive suites under TZ=$zone"
  # shellcheck disable=SC2086
  TZ=$zone node --disable-warning=ExperimentalWarning --test $PATHS
done
