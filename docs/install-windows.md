# Pako on Windows

One line in PowerShell (Windows PowerShell 5.1, which every Windows 10 and 11 has, or PowerShell 7). No administrator needed:

```powershell
irm https://raw.githubusercontent.com/AnxovatomicaES/pako-personal-assistant/main/install.ps1 | iex
```

Already have a copy of Pako? From its folder: `powershell -ExecutionPolicy Bypass -File install.ps1`.

Want to read it first? It is short and commented: [`install.ps1`](../install.ps1). Download it, read it, then run the line above.

The address follows the same rule as the macOS and Linux one ([install.md](install.md)): OWNER/REPO from `package.json`'s `repository`,
on the default branch.

## What it does

1. **Checks Node.js 22.18 or newer and git.** If one is missing it prints the command that installs it and stops; it never installs them for you:
   - `winget install --id OpenJS.NodeJS.LTS -e`
   - `winget install --id Git.Git -e` (Claude Code uses git on Windows too)

   Then close the window, open a new one (so it sees the new programs) and paste the line again.
2. **Puts Pako in `%USERPROFILE%\pako`** with `git clone`, or updates the copy that is already there (`git pull --ff-only`). Running the line again is how you update. A folder that exists and is not Pako (it lacks `src\server.ts`, `src\autostart-windows.ts`, `bin\panel.cjs` or a `package.json` named `pako`, as in a clone of the npm library also called `pako`) is left alone, and the installer stops.
3. **Installs its pieces**: `npm ci --omit=dev --ignore-scripts` (only what Pako runs with, and no package's own install scripts).
4. **Checks Claude Code**, Pako's brain. Without it Pako still starts and says so in its chat; install it and sign in whenever you like, and Pako finds it by itself:
   ```powershell
   irm https://claude.ai/install.ps1 | iex
   claude
   ```
5. **Asks whether Pako should start by itself** when you sign in to Windows (below).
6. **Starts Pako and prints the panel's address.** With autostart, Pako runs with no window and keeps running when you close PowerShell. Without it, Pako runs in that PowerShell window, and closing the window stops it.

| Setting | What |
|---|---|
| `PAKO_DIR` | The folder Pako goes in (default `%USERPROFILE%\pako`) |
| `PAKO_REPO` | The git address it is cloned from (default: the `repository` in `package.json`) |
| `PAKO_AUTOSTART` | `1` or `0`: answers the autostart question without asking it |
| `PAKO_HOME` | Pako's own folder for notes and settings (default `%USERPROFILE%\.pako`), as for `npm.cmd start` |

For example: `$env:PAKO_AUTOSTART = "1"; irm https://raw.githubusercontent.com/AnxovatomicaES/pako-personal-assistant/main/install.ps1 | iex`

## Starting by itself (autostart)

Autostart is a Task Scheduler task that belongs to your account and is called `Pako-<your user name>`. It runs when you sign in, as you, with no window, and has no time limit. It also runs on battery. `src/autostart-windows.ts` makes it with `schtasks` from an XML file, because plain `schtasks` flags cannot make a sign-in task without an administrator, and the tasks they make stop after 72 hours and never start on battery.

The task runs `%USERPROFILE%\.pako\autostart\start-pako.ps1`. That file starts `node.exe` (its full path) on `src\server.ts`, hidden, with `PAKO_NO_OPEN=1` so a browser tab does not open at every sign-in. Pako's output goes to `%USERPROFILE%\.pako\logs\pako.log` and `pako.err.log`, and the previous start's logs are kept as `.old`.

From Pako's folder:

```powershell
node src\autostart-windows.ts status    # on or off (and whether the task still starts this folder with this Node.js)
node src\autostart-windows.ts enable    # make (or remake) the task
node src\autostart-windows.ts disable   # remove it; a running Pako keeps running
node src\autostart-windows.ts start     # run it now, the way it runs at sign-in
npm.cmd run panel                       # a new link to the panel
```

`npm.cmd run autostart -- on|off|status` (the same command as on macOS and Linux) and the panel's **Start with this computer** card use this same task.
From the panel, turning it on takes effect at the next sign-in, and turning it off leaves the running Pako alone.
If you move Pako's folder or reinstall Node.js elsewhere, `status` says the task is for another folder or another Node.js: run `enable` again.

After moving Pako's folder or installing a different Node, run `enable` again: the task holds both full paths.

To stop a Pako that runs with no window, first find its process number with `Get-Content $HOME\.pako\.lock -TotalCount 1`, then run `Stop-Process -Id <that number>`. Without autostart, use Ctrl+C in its window.

## What is different on Windows

- **`npm.cmd`, not `npm`, in PowerShell.** A bare `npm` makes PowerShell run `npm.ps1`, which Windows's default policy refuses ("running
  scripts is disabled on this system"). `npm.cmd` is the same npm and needs no change of policy; in the Command Prompt both work.
- **The `claude` command.** Claude Code's native installer puts `claude.exe` in `%USERPROFILE%\.local\bin`. Installed with npm, it is a `claude.cmd`, which Windows cannot start without a shell. Pako looks on the `PATH` for `claude.exe`, then `claude.cmd`, then in those two folders. For a `claude.cmd`, it runs the script inside it directly with Node. To use another copy, set `CLAUDE_BIN=C:\path\to\claude.exe` in `%USERPROFILE%\.pako\.env`.
- **Stopping.** Ctrl+C, Ctrl+Break and closing the window all stop Pako cleanly: the last notes are written and the lock is released. Windows has no SIGTERM.
- **File permissions.** Windows has no Unix file modes. `%USERPROFILE%\.pako` is private to your account through your user folder's own permissions, the way every other program's settings are.
- **Writing files.** An antivirus or the search indexer can hold a file for a moment just as Pako replaces it. Pako tries again for a fraction of a second instead of losing the write.
- **The browser** is opened with Windows's own URL handler, never through `cmd`.

## If something goes wrong

- *"Windows did not let Pako make the task"*: the message gives Windows's reason. Some work computers forbid scheduled tasks. Start Pako with `npm.cmd start` in its folder instead.
- *Pako does not start at sign-in*: look in `%USERPROFILE%\.pako\logs\pako.err.log`, and in Task Scheduler (`taskschd.msc`) under the `Pako-...` task's history.
- *"running scripts is disabled on this system"*: run the line above as it is (`irm ... | iex` is not a script file), or use `powershell -ExecutionPolicy Bypass -File install.ps1`. The task already starts its file with `-ExecutionPolicy Bypass`, which needs no administrator.
- *A second Pako*: Pako runs once per `%USERPROFILE%\.pako`. A second start, by hand or by the task, says the first one is already running and stops.
