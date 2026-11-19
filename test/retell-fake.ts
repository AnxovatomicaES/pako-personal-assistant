// A tiny Retell for tests: agents and LLMs live in memory; `refuseModel` makes it reject a model id like an account without access.
// It answers only the methods and paths in test/fixtures/retell-contract.json (taken from Retell's OpenAPI file).
import { readFileSync } from "node:fs";

export const CONTRACT = JSON.parse(readFileSync(new URL("./fixtures/retell-contract.json", import.meta.url), "utf8")) as {
  revision: string;
  endpoints: Record<string, { method: string; path: string; props?: string[]; required?: string[] }>;
  enums: Record<string, string[]>;
};

export type Req = { method: string; path: string; body?: any };

/** A tiny Retell: agents and LLMs live in memory; `refuseModel` makes it reject a model id like an account without access. */
export function fakeRetell(opts: { refuseModel?: string; numbers?: string[]; voices?: unknown[] } = {}) {
  const reqs: Req[] = [];
  const agents: { agent_id: string; agent_name: string; voice_id?: string; voice_model?: string | null; response_engine: { type: string; llm_id: string } }[] = [];
  const llms = new Map<string, unknown>();
  // Numbers in the account: the ones given, plus whatever is imported or bought during the test.
  const numbers: string[] = [...(opts.numbers ?? [])];
  let n = 0;
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const path = u.pathname + u.search;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const method = init?.method ?? "GET";
    reqs.push({ method, path, body });
    // Only a method and path that Retell's own API file lists: a wrong verb (GET vs POST) is a 405, as the real API would answer.
    const known = Object.values(CONTRACT.endpoints).some((e) => e.method === method && new RegExp(`^${e.path.replace(/\{[^}]+\}/g, "[^/]+")}$`).test(u.pathname));
    if (!known) return new Response(JSON.stringify({ message: `Method Not Allowed: ${method} ${u.pathname}` }), { status: 405 });
    const ok = (j: unknown, status = 200) => new Response(JSON.stringify(j), { status });
    if ((init?.headers as Record<string, string>).Authorization !== "Bearer key_test") return ok({ message: "bad key" }, 401);
    if (u.pathname === "/list-voices") return ok(opts.voices ?? [{ voice_id: "retell-Andrea", voice_name: "Andrea", provider: "platform", accent: "Neutral" }, { voice_id: "eleven-Lucia", voice_name: "Lucia", provider: "elevenlabs", accent: "British English" }, { voice_id: "retell-Cimo", voice_name: "Cimo", provider: "platform", accent: "Mexican Spanish" }]);
    if (u.pathname === "/create-retell-llm" || u.pathname.startsWith("/update-retell-llm/")) {
      if (opts.refuseModel && body.model_config.primary.model === opts.refuseModel) return ok({ message: "model not available" }, 400);
      const id = u.pathname.startsWith("/update") ? u.pathname.split("/").pop()! : `llm_${++n}`;
      llms.set(id, body.model_config);
      return ok({ llm_id: id }, u.pathname.startsWith("/create") ? 201 : 200);
    }
    if (u.pathname === "/create-agent") {
      const a = { agent_id: `agent_${++n}`, agent_name: body.agent_name, voice_id: body.voice_id, voice_model: body.voice_model, response_engine: body.response_engine };
      agents.push(a);
      return ok(a, 201);
    }
    if (u.pathname.startsWith("/update-agent/")) {
      const a = agents.find((x) => x.agent_id === u.pathname.split("/").pop());
      if (a && body?.voice_id) a.voice_id = body.voice_id;
      if (a && body?.agent_name) a.agent_name = body.agent_name;
      if (a && body && "voice_model" in body) a.voice_model = body.voice_model;
      return ok({ agent_id: u.pathname.split("/").pop() });
    }
    if (u.pathname === "/v2/list-agents") return ok({ has_more: false, items: agents.filter((a) => a.agent_name.includes(body?.filter_criteria?.query ?? "")).map((a) => ({ agent_id: a.agent_id, agent_name: a.agent_name })) });
    if (u.pathname.startsWith("/get-retell-llm/")) return ok({ llm_id: u.pathname.split("/").pop(), model_config: llms.get(u.pathname.split("/").pop()!) ?? { type: "cascading" } });
    if (u.pathname.startsWith("/get-agent/")) return ok(agents.find((a) => a.agent_id === u.pathname.split("/").pop()));
    if (u.pathname === "/v2/list-phone-numbers") return ok({ has_more: false, items: numbers.map((phone_number) => ({ phone_number })) });
    if (u.pathname === "/create-phone-number") {
      numbers.push("+14155550100");
      return ok({ phone_number: "+14155550100" }, 201);
    }
    if (u.pathname === "/import-phone-number") {
      numbers.push(body.phone_number);
      return ok({ phone_number: body.phone_number }, 201);
    }
    if (u.pathname.startsWith("/update-phone-number/")) {
      const num = decodeURIComponent(u.pathname.split("/").pop()!);
      return numbers.includes(num) ? ok({ phone_number: num }) : ok({ message: "not found" }, 404);
    }
    return ok({ message: `unexpected ${method} ${u.pathname}` }, 404);
  }) as typeof fetch;
  return { f, reqs, agents };
}

