// `node src/bridge-token.ts <Pako folder>`: prints that folder's bridge token on stdout, wherever it is kept (src/secrets.ts), and nothing
// else; exits 1 with nothing printed when it cannot be read. For `npm run panel` (bin/panel.cjs), which is plain JavaScript and asks the
// running Pako for a sign-in link with it. The token goes through a pipe only, never a command line or a file.

import { readSecrets } from "./secrets.ts";

const dir = process.argv[2] ?? "";
const token = dir ? readSecrets(dir)?.bridgeToken : undefined;
if (typeof token === "string" && token) process.stdout.write(token);
else process.exitCode = 1;
