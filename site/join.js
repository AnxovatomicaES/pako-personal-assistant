// The newsletter block ("Loose Ends"), shared by every page of the site. It upgrades each <div class="join" data-pitch="..."> and keeps
// the visit's source tag (?s=ig) on the links that carry data-keep-source. No cookies, no analytics, no third-party requests.

// "form": an email field that posts to the sign-up endpoint (double opt-in). "mail": a button that opens the visitor's mail app
// with a ready message; it is also what the form falls back to when the endpoint does not answer.
const JOIN_MODE = "form";
const JOIN_URL = "https://join.pako-os.com/api/join";

(function () {
  const PITCH = "Loose Ends: one short email on Sunday evening, so Monday starts with fewer of them.";
  const BODY = "Send%20this%20email%20as%20it%20is%20and%20you%27re%20in.%20First%20thing%20you%20get%3A%20the%2012%20follow-up%20texts.";

  /** The visit's source tag: ?s= on the address (letters, digits and hyphens only), else the one kept for this visit, else "site". */
  function sourceTag() {
    const ok = /^[a-z0-9-]{1,16}$/;
    const asked = new URLSearchParams(location.search).get("s");
    if (asked && ok.test(asked)) {
      try { sessionStorage.setItem("pako-s", asked); } catch { /* private mode or storage off: the tag still holds for this page */ }
      return asked;
    }
    try {
      const kept = sessionStorage.getItem("pako-s");
      if (kept && ok.test(kept)) return kept;
    } catch { /* storage off: the default is right */ }
    return "site";
  }
  const tag = sourceTag();

  function el(name, props, ...children) {
    const node = Object.assign(document.createElement(name), props || {});
    node.append(...children);
    return node;
  }

  const mailto = () => `mailto:join@pako-os.com?subject=Subscribe%20me%20(${tag})&body=${BODY}`;

  /** The one-tap way in: a real mailto link, with its fine print. */
  function mailParts(lead) {
    return [
      ...(lead ? [el("p", { className: "join-fine" }, lead)] : []),
      el("a", { className: "join-btn", href: mailto() }, "Email me in"),
      el("p", { className: "join-fine" }, "Opens your mail app with a ready message. Press send and you're in."),
    ];
  }

  function formParts(live) {
    const id = `join-email-${Math.random().toString(36).slice(2, 8)}`;
    const email = el("input", { type: "email", id, name: "email", autocomplete: "email", required: true, placeholder: "you@example.com" });
    // The honeypot: people never see or reach it; a script that fills every field gives itself away.
    const company = el("input", { type: "text", name: "company", tabIndex: -1, autocomplete: "off" });
    const trap = el("div", { className: "join-trap" }, company);
    trap.setAttribute("aria-hidden", "true");
    const button = el("button", { type: "submit", className: "join-btn" }, "Send me the texts");
    const form = el("form", { className: "join-form" },
      el("label", { htmlFor: id, className: "join-label" }, "Your email address"), el("div", { className: "join-row" }, email, button), trap);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      button.disabled = true;
      let ok = false;
      try {
        const res = await fetch(JOIN_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email.value.trim(), s: tag, company: company.value }),
        });
        ok = res.status === 200 && (await res.json()).ok === true;
      } catch { /* offline, or an answer that is not JSON: the mail button below does the same job */ }
      if (ok) {
        form.remove();
        live.replaceChildren(el("p", { className: "join-done" }, "Check your inbox: one click to confirm."));
      } else {
        button.disabled = false;
        live.replaceChildren(...mailParts("That didn't go through. One tap does the same:"));
      }
    });
    return [form];
  }

  for (const box of document.querySelectorAll("div.join")) {
    const live = el("div", { className: "join-live" });
    live.setAttribute("aria-live", "polite");
    const privacy = el("a", { href: "/privacy.html#newsletter" }, "Privacy");
    box.replaceChildren(
      el("p", { className: "join-pitch" }, box.dataset.pitch || PITCH),
      el("p", { className: "join-promise" }, "One idea, one text to copy. Unsubscribe by replying STOP. ", privacy),
      ...(JOIN_MODE === "form" ? formParts(live) : mailParts()),
      live,
    );
  }

  if (tag !== "site") {
    for (const link of document.querySelectorAll("a[data-keep-source]")) {
      const url = new URL(link.getAttribute("href"), location.href);
      if (url.origin !== location.origin) continue;
      url.searchParams.set("s", tag);
      link.href = url.pathname + url.search + url.hash;
    }
  }
})();
