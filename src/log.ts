// The server's log: src/log-core.ts (levels, text or JSON lines, secrets hidden) with the one-time codes of the owner's mail hidden too, by
// the same rules src/codes.ts uses before a mail is kept or shown. Every file of the server and of the assistant's bridge imports this one.

import { hideCodes } from "./codes.ts";
import { configureLog } from "./log-core.ts";

configureLog({ scrub: (text) => hideCodes(text, "en").text });

export { createLog, formatEntry, isSecretName, log, logBody, logFormat, logLevel, redactFields, scrubText } from "./log-core.ts";
export type { Log, LogEntry, LogFields, LogLevel } from "./log-core.ts";
