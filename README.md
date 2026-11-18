# SessionBrain

A live view of what a Claude Code session is doing, in its own window or in an Orca tab beside the
terminal. Every tool call blooms as ink in its activity's colour (shell, files, model, network,
memory, subagents, skills, hooks…), a caption says what Claude is doing right now, a timeline shows
the last five minutes, and the calls run down the side.

The map is [lot-map](https://github.com/alexeyw/lot-map) by Aleksei Volodin (MIT). lot-map draws it
in a pane inside Claude Code, which a terminal session can only show as text. SessionBrain draws the
same map outside the terminal, and needs nothing inside Claude Code to do it: it reads the
session's transcript, which Claude Code writes anyway.

```
Claude Code (any session, any terminal)      sessionbrain-app hub (systemd user service)      Views
  ~/.claude/sessions/<pid>.json  ── open? ──▶  follows each open session's transcript  ── SSE ──▶  sessionbrain-app window (WebKitGTK)
  ~/.claude/projects/…/<id>.jsonl ── lines ─▶  keeps a slim copy of recent records      127.0.0.1:7317  Orca browser tab (/sessionbrain)
                                                                                              page: records → lot-map's board → drawMap
```

`sessionbrain-app` is one Rust program (in `app/`) that is both the hub and the window. The window
shows the hub's page in WebKitGTK through wry, so the map is exactly the page any browser sees.

## Install

```bash
./install.sh            # again after pulling, to update; ./install.sh --uninstall to remove
```

It needs `cargo` and `bun` to build (bun only bundles the page; nothing runs on it). It installs:

- `sessionbrain-app` (the hub and the window) and the `sessionbrain` command in `~/.local/bin`;
- the hub, as `sessionbrain-hub.service`, a systemd user service that starts at login (and again within
  two seconds if it ever crashes);
- a **SessionBrain** entry in the app launcher;
- the `/sessionbrain` command for Claude Code, as the user-scope plugin `sessionbrain@sessionbrain`. It hooks
  nothing else, so it cannot slow down or change a session.

Every session shows up, including ones that were open before SessionBrain was installed.

## Use

- **The key:** Super + Shift + W (set in `~/.config/hypr/bindings.lua`, not by the installer) runs
  `sessionbrain here`: the window on the session in the focused window (in Orca, the one that wrote
  last; with no session there, the most recently active one). With the window already open it
  switches to that session and comes forward.
- **The window:** open SessionBrain from the launcher, or run `sessionbrain`. It lists the open Claude
  sessions; pick one to follow it live. Use the menu in the bar to switch. Sessions that close stay
  listed for half an hour, showing where they finished.
- **Beside the session in Orca:** type `/sessionbrain` in the session. It opens a browser tab split to the
  right of the terminal, in the same worktree. Running it again brings that tab forward.
- **From outside Orca**, `/sessionbrain` opens the window on that session.
- **Forcing one or the other:** `/sessionbrain window` and `/sessionbrain tab`.
- **Display options:** under ⚙: the view (ink, or the diagram: lot-map's ring of activities), the skin
  (Classic, Neon, Synthwave, Phosphor, Ice, Ember, or Omarchy, which follows your desktop theme as
  you change it), language, layout and the name at the centre.

Other commands: `sessionbrain sessions`, `sessionbrain hub status|restart|logs`, `sessionbrain url --session ID`,
and `sessionbrain-app records <transcript.jsonl>` (prints what the hub takes from a transcript).

## What goes where

| Part | Files | Notes |
| --- | --- | --- |
| Transcript reader | `app/src/transcript.rs` | Finds `~/.claude/projects/<folder>/<id>.jsonl` and its `subagents/*.jsonl`, reads what is new the moment the kernel says a file changed (inotify; about 1 ms from Claude's write to the page), with a 0.4 s check as a backstop, and keeps a slim copy of the records the map uses: tool calls with their inputs cut to 300 characters, results as ok/error/refused, model, request, context size, prompts, turn ends, compactions, context a hook added. Message text, tool output and thinking are not kept |
| Hub | `app/src/hub.rs`, `registry.rs`, `sessions.rs` | Open sessions come from `~/.claude/sessions/*.json` (checked against each process's start time), falling back to `claude agents --json` where that folder cannot be read. Pages are on `127.0.0.1` only, on the account's own port (7317 for the first account, one up for each after it), and need the account's key (`~/.local/state/sessionbrain/key`, readable by that account only): the window and `sessionbrain` add it, and a page that showed it once keeps it in a cookie. Requests with any other Host header are refused |
| Adapter | `web/adapter.ts` | Folds the records into lot-map's board. Each rule follows one of lot-map's reducers; times are the transcript's own, so a map opened mid-session shows real durations |
| Map | `web/lot-map/` | lot-map's `map.ts` and `text.ts`, unchanged apart from an import path, and its types (commit in `LOT_MAP_COMMIT`) |
| Window | `app/src/window.rs` | wry on WebKitGTK; Hyprland class `sessionbrain-app`. On Hyprland it pauses the map while on a workspace that is not shown. With no hub running it carries one itself while open |
| Page | `web/` | Bundled into the binary at build time with its typefaces (Geist and Geist Mono, SIL OFL, in `web/fonts/`), so it needs no network. The ink (`ink.ts`) is a WebGL simulation: each call drops ink in its activity's colour at that activity's place, marked by its shape (`shapes.ts`); running calls keep feeding it; a slow current draws it in towards Claude and it fades over about twenty seconds. It runs at 30 frames a second just after something happens, slower while ink drifts, and stops once still. The caption (`caption.ts`) says what Claude is doing now, the timeline (`timeline.ts`) the last five minutes. The diagram (`scope.ts`) is the other view, and the fallback without WebGL. Paused out of sight |
| Launcher | `bin/sessionbrain`, `install/` | Orca tabs, the systemd service and the launcher entry. Needs only bash (curl and jq are not required) |
| Command | `plugin/` | `/sessionbrain`: runs `sessionbrain open --session <this session>` |

Claude Code's transcript and session files are its own and undocumented. If their format changes,
records the reader does not recognise are skipped rather than breaking anything, and
`sessionbrain-app records` shows what is still understood.

## Cost

Measured on this machine:

| | |
| --- | --- |
| Hub, 3 real sessions | 40 MB; under 0.1% of a core |
| Hub, 40 sessions with 9 MB transcripts each, 10 of them written to at about 90 lines a second, 3 pages open | ready in under 1 s; 103 MB; 0.3% of a core while written to, 0.1% idle |
| Window (whole process tree) | about 240 MB; about 9% of a core while a session works (1875 × 1030 window), 0% out of sight and once the ink has settled |

## Develop

```bash
bun install
bun run build    # cargo build --release (bundles the page with bun on the way)
bun run test     # Rust unit tests; the adapter's tests, including every transcript in ~/.claude/projects;
                 # the hub's end-to-end tests against the binary; the /sessionbrain command's tests
bun run check    # typecheck the page
claude plugin validate plugin
SESSIONBRAIN_PORT=7399 app/target/release/sessionbrain-app hub      # a second hub, beside the installed one
SESSIONBRAIN_PORT=7399 SESSIONBRAIN_DEBUG=1 app/target/release/sessionbrain-app window   # a window on it, logging what the page reports
```

After changing anything, run `./install.sh` again: it rebuilds `sessionbrain-app`, restarts the hub,
and updates the command for new sessions.

## Licence

SessionBrain is MIT. lot-map's files keep their own MIT notice: see `web/lot-map/LICENSE-lot-map`. The Geist font
files are under the SIL Open Font License: see `web/fonts/LICENSE-geist`.

## Art

The nodes in the ink view and the plate under it are rendered in Blender (Cycles) by `art/render.py`,
into `web/art/`, and embedded in the binary at build time. Each node has its object (`<id>.webp`) and a
white glow mask (`<id>-glow.webp`) that the page tints with the activity's colour; the plate is grey, 50%
being the theme's ground. So skins and the desktop theme apply without a re-render. To render again:

    BLENDER=/path/to/blender bun run art            # everything (a few seconds on a GPU)
    BLENDER=/path/to/blender bun run art --only web,shell
