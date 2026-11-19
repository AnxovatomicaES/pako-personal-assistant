// The persona (beta-plan step 4): a chief of staff by default; the friend, the health companion and the teacher only with Labs on; health
// limited to safety (a red flag gets the emergency number first, anything else a professional) in both.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SYSTEM_PROMPT, systemPromptFor, TOOLS_SYSTEM_PROMPT, toolsSystemPromptFor } from "../assistant/prompt.ts";

test("by default a chief of staff: no friend, companion or teacher roles; the red flags and «see a professional» are always there", () => {
  for (const p of [SYSTEM_PROMPT, TOOLS_SYSTEM_PROMPT]) {
    assert.match(p, /their chief of staff/);
    assert.match(p, /nothing they promised, or were promised, gets dropped/);
    assert.doesNotMatch(p, /As a friend|As a health companion|As a teacher|__COMPANION__/);
    assert.match(p, /the first thing you write is to call the emergency number now/);
    assert.match(p, /never diagnose, never prescribe and never change or suggest a dose/);
    assert.match(p, /deserves a professional's look/);
  }
  assert.equal(systemPromptFor(false), SYSTEM_PROMPT);
});

test("with Labs on: the companion's roles are added, the safety rule stays first and is not repeated as advice before it", () => {
  for (const p of [systemPromptFor(true), toolsSystemPromptFor(true)]) {
    assert.match(p, /With Labs on, more than a chief of staff/);
    assert.match(p, /As a friend[\s\S]*As a health companion \(the red flags above always come first\)[\s\S]*As a teacher/);
    assert.match(p, /the first thing you write is to call the emergency number now/);
    assert.ok(p.indexOf("Health and safety, always") < p.indexOf("As a health companion"));
  }
  assert.ok(systemPromptFor(true).length > SYSTEM_PROMPT.length);
});
