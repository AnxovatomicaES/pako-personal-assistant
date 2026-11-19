#!/usr/bin/env node
// `npm run panel`: a fresh one-time link to the panel of the Pako running on this computer, printed and opened in the browser. For when the link
// Pako printed at the start was used, or is older than its ten minutes, or the browser was closed: nothing has to be restarted.
//
// It proves it is the owner with the bridge token of Pako's home folder (in the system's keychain, or ~/.pako/secrets.json) and asks the running
// server for a link (POST /panel/api/link, answered on this computer's own address only). The server is found by the lock it holds in that
// folder (src/local.ts, lockHome: its process and its port). With no live lock nothing is asked at all: the token is never sent to whatever
// else may be listening on a port while Pako is stopped. Plain CommonJS with nothing newer than ES2018 and no dependencies, like
// bin/preflight.cjs: it must work from any terminal, whatever Node that terminal has.
"use strict";

var childProcess = require("child_process");
var fs = require("fs");
var http = require("http");
var os = require("os");
var path = require("path");

/**
 * The NAME=value lines of a .env file, for the names asked, read as Node reads them for `npm start` (process.loadEnvFile): a quoted value is
 * what is between its quotes; in one that is not, a # starts a comment; a name given twice keeps the last. A file that is not there gives nothing.
 */
function readEnvFile(file, names) {
  var out = {};
  var text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    return out;
  }
  text.split(/\r?\n/).forEach(function (line) {
    var m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || names.indexOf(m[1]) < 0) return;
    var value = m[2].trim();
    var quoted = /^(["'`])(.*?)\1(?:\s*#.*)?$/.exec(value);
    out[m[1]] = quoted ? quoted[2] : value.replace(/#.*$/, "").trim();
  });
  return out;
}

/**
 * Pako's home folder, found as `npm start` finds it (src/server.ts): this terminal's PAKO_HOME first, then the one in the home folder's .env,
 * then the one in the .env of the Pako folder; ~/.pako when none says.
 */
function pakoHome(env, cwd, userHome) {
  var first = (env.PAKO_HOME || "").trim() || path.join(userHome, ".pako");
  var files = [readEnvFile(path.join(first, ".env"), ["PAKO_HOME"]), readEnvFile(path.join(cwd, ".env"), ["PAKO_HOME"])];
  var given = env.PAKO_HOME !== undefined ? env.PAKO_HOME : files[0].PAKO_HOME !== undefined ? files[0].PAKO_HOME : files[1].PAKO_HOME;
  return String(given || "").trim() || first;
}

/**
 * The lock of the Pako using this folder (src/local.ts, lockHome): its process, its port (0 when a Pako from before this command wrote it) and
 * whether it is still there. A lock left by a Pako that was killed, or from before the computer last restarted (it has been up for less time
 * than it had then, so that process number may be any program's now), is not a live one. Null when there is no lock.
 */
function readLock(home, upSeconds) {
  var lines;
  try {
    lines = fs.readFileSync(path.join(home, ".lock"), "utf8").split("\n");
  } catch (err) {
    return null;
  }
  var pid = parseInt(lines[0], 10);
  if (!(pid > 0)) return null;
  var port = parseInt(lines[1], 10);
  var alive = !(/^\d+$/.test(lines[2] || "") && upSeconds < Number(lines[2]));
  if (alive) {
    try {
      process.kill(pid, 0);
    } catch (err) {
      alive = err.code === "EPERM";
    }
  }
  return { pid: pid, port: port > 0 && port < 65536 ? port : 0, alive: alive };
}

/** The bridge token Pako made on its first start, or "" when it has never started with this folder. */
function bridgeToken(home) {
  var saved;
  try {
    saved = JSON.parse(fs.readFileSync(path.join(home, "secrets.json"), "utf8"));
  } catch (err) {
    return "";
  }
  if (!saved || typeof saved !== "object") return "";
  if (!saved._store) return typeof saved.bridgeToken === "string" ? saved.bridgeToken : "";
  return storedBridgeToken(home, saved);
}

/**
 * The bridge token when the secrets are in the system's store (src/secrets.ts): secrets.json is then a marker naming the service and the
 * account. On a Mac, read as Pako itself reads it, with /usr/bin/security (whatever Node this terminal has); elsewhere through Pako's own
 * reader (src/bridge-token.ts, which needs the Node Pako runs on). The value comes back on a pipe, never on a command line. "" when it cannot.
 */
function storedBridgeToken(home, marker) {
  var name = /^[A-Za-z0-9._:-]{1,200}$/;
  if (process.platform === "darwin" && marker._store === "keychain") {
    if (!name.test(String(marker._service)) || !name.test(String(marker._account))) return "";
    var r = childProcess.spawnSync(
      "/usr/bin/security",
      ["find-generic-password", "-s", marker._service, "-a", marker._account + ":bridgeToken", "-w"],
      { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL" },
    );
    if (r.status !== 0 || r.error) return "";
    try {
      var v = JSON.parse(String(r.stdout).replace(/\n$/, ""));
      return typeof v === "string" ? v : "";
    } catch (err) {
      return "";
    }
  }
  var out = childProcess.spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", path.join(__dirname, "..", "src", "bridge-token.ts"), home],
    { encoding: "utf8", timeout: 30000, killSignal: "SIGKILL", windowsHide: true },
  );
  return out.status === 0 && !out.error ? String(out.stdout) : "";
}

/** Asks one address of this computer for a link: done(error) or done(null, status, body). Never waits more than a few seconds. */
function askAt(host, port, token, done) {
  var finished = false;
  var finish = function (err, status, body) {
    if (finished) return;
    finished = true;
    done(err, status, body);
  };
  var req = http.request(
    {
      host: host,
      port: port,
      path: "/panel/api/link",
      method: "POST",
      // A connection of its own, closed after the answer: a kept-alive one would hold the terminal for seconds after the line is printed.
      agent: false,
      headers: { authorization: "Bearer " + token, "content-length": "0", connection: "close" },
    },
    function (res) {
      var body = "";
      res.setEncoding("utf8");
      res.on("data", function (chunk) {
        if (body.length < 10000) body += chunk;
      });
      res.on("end", function () {
        finish(null, res.statusCode, body);
      });
      res.on("error", finish);
    }
  );
  req.setTimeout(5000, function () {
    req.destroy(new Error("no answer in 5 s"));
  });
  req.on("error", finish);
  req.end();
}

/**
 * The IPv4 loopback only, where Pako listens. Never [::1] when it refuses: Pako may hold its lock and not listen yet (starting, or at its name
 * question), and another account on this computer can listen on [::1] at the same port (a separate socket) and take the bridge token.
 */
function ask(port, token, done) {
  askAt("127.0.0.1", port, token, done);
}

function openBrowser(url) {
  var how = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    var p = childProcess.spawn(how[0], how[1], { stdio: "ignore", detached: true });
    p.on("error", function () {});
    p.unref();
  } catch (err) {
    // no browser here: the link is printed anyway
  }
}

/** npm as typed here: npm.cmd on Windows, where PowerShell's default policy refuses the npm.ps1 a bare `npm` runs. */
var NPM = process.platform === "win32" ? "npm.cmd" : "npm";

/** The sentences for each way it can go (English, like all of Pako's own words). */
var SAY = {
  notStarted: function (home) {
    return ["Pako has not started with the folder " + home + " yet. Start it with " + NPM + " start in the Pako folder: it opens the panel by itself."];
  },
  notRunning: function () {
    return ["Pako is not running. Start it with " + NPM + " start in the Pako folder: it opens the panel by itself."];
  },
  starting: function (pid, port) {
    return [
      "Pako is starting (process " + pid + ") but does not answer on port " + port + " yet. Look at its terminal: if it asks what to call you,"
        + " answer. Then run " + NPM + " run panel again.",
    ];
  },
  older: function (pid) {
    return [
      "The running Pako (process " + pid + ") is from before " + NPM + " run panel: restart it once (Ctrl+C in its terminal, then " + NPM + " start) and it opens"
        + " the panel with a fresh link.",
    ];
  },
  otherHome: function (port, home) {
    return [
      "The Pako on port " + port + " does not use the folder " + home + ": it was started with another one (PAKO_HOME). Ask with that one: "
        + (process.platform === "win32" ? "$env:PAKO_HOME=\"that\\folder\"; " : "PAKO_HOME=that/folder ") + NPM + " run panel",
    ];
  },
  noRoute: function (port) {
    return ["Whatever answers on port " + port + " gives no links: it is not a Pako of this folder. If Pako has stopped, start it with " + NPM + " start."];
  },
  tooMany: function () {
    return ["Too many links in a row: wait a few minutes and try again."];
  },
  broken: function (port, why) {
    return [
      "Pako is not answering properly on port " + port + " (" + why + "). If it is stuck, stop it with Ctrl+C in its terminal and start it again with " + NPM + " start.",
    ];
  },
};

function fail(lines) {
  process.stderr.write("\n  " + lines.join("\n  ") + "\n\n");
  process.exitCode = 1; // not exit(): what was written to a pipe is not cut short
}

function main() {
  var home = pakoHome(process.env, process.cwd(), os.homedir());
  var token = bridgeToken(home);
  if (!token) return fail(SAY.notStarted(home));
  var lock = readLock(home, os.uptime());
  if (!lock || !lock.alive) return fail(SAY.notRunning());
  if (!lock.port) return fail(SAY.older(lock.pid));
  var port = lock.port;
  ask(port, token, function (err, status, body) {
    // It holds the lock but listens nowhere yet: it is starting, or waiting at its name question.
    if (err) return fail(err.code === "ECONNREFUSED" ? SAY.starting(lock.pid, port) : SAY.broken(port, err.message));
    if (status === 401) return fail(SAY.otherHome(port, home));
    if (status === 404) return fail(SAY.noRoute(port));
    if (status === 429) return fail(SAY.tooMany());
    var link = "";
    try {
      link = String(JSON.parse(body).link || "");
    } catch (parseErr) {
      link = "";
    }
    if (status !== 200 || !/^https?:\/\/\S+$/.test(link)) return fail(SAY.broken(port, "HTTP " + status));
    var open = process.env.PAKO_NO_OPEN !== "1";
    process.stdout.write(
      "\n  Your Pako panel:\n\n    " + link + "\n\n  ("
        + (open ? "opening your browser; " : "")
        + "the link works once, for 10 minutes)\n\n"
    );
    if (open) openBrowser(link);
  });
}

if (require.main === module) main();

module.exports = { readEnvFile: readEnvFile, pakoHome: pakoHome, readLock: readLock };
