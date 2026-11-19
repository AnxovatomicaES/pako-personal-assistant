// The website's preview of the brief: the app's real page (brief-page.js) asks its server for today's brief; here this file answers instead,
// with a sample day. Nothing leaves the page. The buttons work as in the app: a box ticked stays ticked, "Let's do it" and "Prep me" write
// a short note after a moment, 👍/👎 are kept.
(() => {
  const at = new Date();
  at.setHours(8, 0, 0, 0);
  const refs = [
    { id: "s1", icon: "slack", label: "Slack · #q4-launch" },
    { id: "s2", icon: "slack", label: "Slack · Samir" },
    { id: "z1", icon: "zoom", label: "Zoom · Weekly sync" },
    { id: "m1", icon: "mail", label: "Mail · Rohan" },
    { id: "m2", icon: "mail", label: "Mail · Bank" },
    { id: "c1", icon: "calendar", label: "Calendar" },
    { id: "t1", icon: "tasks", label: "Tasks" },
    { id: "p1", icon: "people", label: "Ana" },
  ];
  const state = {
    lang: "en",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    pending: false,
    tasks: [],
    doc: {
      id: "demo",
      at: at.getTime(),
      day: "demo",
      opening: "Good morning. A full but clear day: the Q4 deck is the one thing that moves the week, Rohan's meeting moved to 10:00, "
        + "and Ana's birthday is tomorrow.",
      focus: {
        title: "Finish the Q4 deck before the 15:00 review",
        story: "Three slides are still empty (pricing, the roadmap, the ask). Rohan wants the numbers by noon, and yesterday's sync agreed "
          + "the roadmap slide follows the new launch date.",
        offer: "I can draft the three missing slides from last week's notes and the sync's summary.",
        sources: ["z1", "m1", "s1"],
      },
      todos: [
        {
          title: "Set up the 5:15 PM ET call with Samir and Michael",
          context: "Samir asked on Slack yesterday at 18:40. 5:15 PM ET is 23:15 here.",
          checked: "no meeting on Zoom or your calendar yet",
          sources: ["s2"], done: false, loopId: "l1",
        },
        {
          title: "Send Rohan the pricing numbers",
          context: "He asked for them before the review, by noon.",
          checked: "nothing sent from your mail since he asked",
          sources: ["m1"], done: false, loopId: "l2",
        },
        {
          title: "Call the bank about the transfer",
          context: "Their email says the transfer is on hold until you confirm it.",
          sources: ["m2", "t1"], done: false,
        },
        {
          title: "Book the restaurant for Friday",
          context: "You told me: four people, Japanese, around 9.",
          sources: ["t1"], done: true,
        },
      ],
      updates: [
        { n: 1, tag: "Moved", title: "The meeting with Rohan is now at 10:00", text: "It was on Tuesday at 16:00; he moved it in his email last night.", sources: ["m1", "c1"] },
        { n: 2, tag: "Decided", title: "The launch date moves to 3 December", text: "Agreed in yesterday's weekly sync; the roadmap slide follows it.", sources: ["z1"] },
        { n: 3, tag: "Tomorrow", title: "Ana's birthday", text: "Your sister. Want me to draft a message you send yourself?", sources: ["p1"] },
      ],
      dayItems: [
        { time: "09:30", end: "09:45", title: "Standup", confirmed: true, sources: ["c1"] },
        { time: "10:00", end: "10:45", title: "Rohan · pricing", confirmed: true, note: "Moved from Tuesday.", sources: ["c1", "m1"] },
        { time: "13:00", end: "14:00", title: "Lunch with Ana", confirmed: true, sources: ["c1"] },
        { time: "15:00", end: "16:00", title: "Q4 deck review", confirmed: true, sources: ["c1", "s1"] },
        { time: "23:15", title: "Call with Samir and Michael", confirmed: false, note: "Agreed on Slack, not on any calendar yet.", sources: ["s2"] },
      ],
      refs,
      sourcesUsed: ["calendar", "mail", "slack", "zoom", "tasks", "people"],
    },
  };
  const verdicts = {};
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const NOTES = {
    do: "Draft ready: 1) Pricing: the three tiers from the 4 Nov notes, with the discount Rohan asked about. 2) Roadmap: launch on 3 December, "
      + "beta two weeks before. 3) The ask: two engineers for Q1. Open the deck to review it.",
    prep: "Prep: what was agreed last time, what is still open, and the one question to ask.",
  };
  const real = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = new URL(String(input), location.href);
    if (!url.pathname.startsWith("/panel/api/")) return real(input, init);
    const body = init.body ? JSON.parse(init.body) : null;
    switch (url.pathname) {
      case "/panel/api/brief/today":
        return json(200, structuredClone(state));
      case "/panel/api/quality/brief":
        if (body) verdicts[`${body.kind[0]}${body.i}`] = body.verdict;
        return json(200, { ok: true, verdicts });
      case "/panel/api/brief/check":
        state.doc.todos[body.i].done = body.done;
        return json(200, { ok: true });
      case "/panel/api/brief/ask": {
        const task = { kind: body.kind, ...(body.ref !== undefined ? { ref: body.ref } : {}), status: "pending", text: "" };
        state.tasks.push(task);
        setTimeout(() => Object.assign(task, { status: "done", text: NOTES[body.kind] ?? NOTES.prep }), 2500);
        return json(200, { ok: true });
      }
      default:
        return json(404, {});
    }
  };
})();
