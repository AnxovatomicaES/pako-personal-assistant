#!/usr/bin/env node
// Runs before `npm start` and `npm run dev` (the "prestart" and "predev" scripts). On a Node.js too old for Pako, or before `npm install`, the
// start would end in an error from deep inside Node that says nothing a newcomer can act on; this says the one thing to do, and stops.
//
// Plain CommonJS with nothing newer than ES2018 and no dependencies: its whole job is to run on a Node that is too old, in a folder with nothing
// installed. It prints nothing when all is well, so a server's start (Render runs `npm start`) looks the same as before.
"use strict";

var fs = require("fs");
var path = require("path");

/** The oldest Node.js that runs Pako's TypeScript as it is (type stripping on by default): 22.18, or 23.6 on the short-lived 23 line. */
function nodeOk(version) {
  var parts = String(version).replace(/^v/, "").split(".");
  var major = parseInt(parts[0], 10) || 0;
  var minor = parseInt(parts[1], 10) || 0;
  if (major === 22) return minor >= 18;
  if (major === 23) return minor >= 6;
  return major > 23;
}

/**
 * What keeps Pako from starting, or null when nothing does. `has(name)` says whether a dependency is installed. Only `dependencies` count: a
 * server installed with `npm ci --omit=dev` (Render) has none of the devDependencies and needs none of them.
 */
function check(o) {
  if (!nodeOk(o.version)) return { problem: "node", version: String(o.version).replace(/^v/, "") };
  var names = Object.keys(o.dependencies || {});
  var missing = names.filter(function (name) {
    return !o.has(name);
  });
  if (missing.length) return { problem: "install", missing: missing, all: missing.length === names.length };
  return null;
}

/** What to tell the person (English, like all of Pako's own words): what is wrong and the one thing to do about it. */
function message(found) {
  if (found.problem === "node") {
    return [
      "",
      "  Pako needs Node.js 22.18 or newer, and this is Node.js " + found.version + ".",
      "  Install a recent one (the LTS): from https://nodejs.org, with nvm (nvm install --lts) or with Homebrew (brew install node).",
      "  Then, in this folder: npm install && npm start",
      "",
    ].join("\n");
  }
  // Nothing installed is the usual first time; a few missing is a `git pull` that brought a new one, and their names say so.
  var which = found.all ? "" : " (" + found.missing.slice(0, 3).join(", ") + (found.missing.length > 3 ? ", …" : "") + ")";
  return [
    "",
    "  Pako's dependencies are not installed in this folder" + which + ": run npm install, then npm start.",
    "",
  ].join("\n");
}

if (require.main === module) {
  var root = path.join(__dirname, "..");
  var pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  var found = check({
    version: process.versions.node,
    dependencies: pkg.dependencies,
    // On disk in this folder's node_modules, not wherever Node would look: a node_modules higher up is not this install.
    has: function (name) {
      return fs.existsSync(path.join(root, "node_modules", name, "package.json"));
    },
  });
  if (found) {
    process.stderr.write(message(found) + "\n");
    process.exitCode = 1; // not exit(): what was written to a pipe is not cut short
  }
}

module.exports = { nodeOk: nodeOk, check: check, message: message };
