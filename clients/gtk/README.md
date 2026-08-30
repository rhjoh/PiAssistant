# Agent GUI (GTK)

A GTK3 desktop client for the Pi assistant gateway. It is designed to be
spawned and toggled from a launcher key binding: the first press opens the
window, later presses minimize/restore it (see [Launcher key setup](#launcher-key-setup)).

## Dependencies

- Python 3.10+ with PyGObject (`gi`) for GTK3
- `websockets` — threaded WebSocket transport
- `markdown` — assistant-turn Markdown rendering
- A monospace font for the transcript (set in `config.py`, default
  `JetBrainsMonoNL Nerd Font`)

## Run

```bash
./agent-gui.py          # run directly (opens the window)
./toggle.sh             # launch unless an instance is already running
```

`toggle.sh` is a launch fallback: it exits when the PID file
(`$XDG_RUNTIME_DIR/agent-gui.pid`) names a live process, otherwise it
launches `agent-gui.py`. The GUI takes the PID file with `O_EXCL` (no
duplicates even on rapid launches) and removes it on exit.

## Code layout

- `agent-gui.py` — GTK window composition and gateway event routing
- `transcript.py` — transcript buffer, streaming state, and GTK rendering
- `gateway_client.py` — threaded asyncio/WebSocket transport
- `markdown_renderer.py` — GTK-free Markdown parsing and highlighting helpers
- `commands.py` — slash-command definitions, matching, and parsing
- `model_picker.py` — headless fuzzy matching for the model picker
- `protocol.py` — gateway payload normalization and heartbeat filtering
- `status_view.py` — connection/model status presentation
- `instance_lock.py` — PID-file single-instance lifecycle
- `window_state.py` — persistent normal size and maximize state
- `config.py` — shared endpoint and visual constants
- `tests/` — headless unit tests for the extracted logic

## What it does

- Connects to the gateway WebSocket API (`ws://127.0.0.1:3456/`)
- Loads the full session history on connect
- Streams assistant replies, thinking blocks, and tool events live; the
  transcript uses the configured monospace font
- User messages render as flat full-width bands with a full-height left
  accent bar
- **Markdown rendering**: assistant turns are rendered via the `markdown` lib
  when they complete — headings, bold/italic, inline code, code blocks,
  blockquotes, lists, links, and tables (aligned monospace grid); code blocks
  have one-click copy buttons
- Thinking blocks render as an indented italic `▾ Thinking` section; when
  hidden, each block remains visible as `▸ Thinking hidden — Ctrl+T to show`
- Streaming shows a blinking cursor and hides common markdown markers until
  the completed turn is rendered
- Transcript scrolling follows new content while pinned to the bottom, but
  leaves the user's position alone when they scroll up
- Heartbeat messages are filtered like the web UI does
  (`[Heartbeat]` / `[[NO_ACTION]]` markers)
- **Ctrl+T** toggles thinking blocks; **Ctrl+O** collapses/expands tool-call
  blocks
- Pi extension prompts (question tool, permission-gate, plan-mode, goal)
  appear as a scrollable option/input panel above the composer; Escape cancels
- Compaction, retries, and "waiting for your answer" show in the status bar
  and a working banner above the prompt
- Gateway errors, extension errors, and warning notifications render in red
- The client reconnects if the gateway restarts and refreshes model/context
  from pushed `state` events
- Tool output and code blocks have copy buttons; with the transcript focused,
  `Ctrl+A` selects all and `Ctrl+Shift+C` copies the selection
- Prompt entry: Enter sends, `Shift+Enter` inserts a newline, `Alt+Enter`
  queues a follow-up while the agent is busy; slash-command suggestions appear
  above the entry as you type (prefix or fuzzy matches) and `Tab`/`↑`/`↓`/
  `Enter` navigate or accept them
- `/model`, `/model list`, or `/models` opens a searchable model picker
  (fuzzy filter by provider, model ID, or name; `/models <search>` opens with
  an initial filter)
- `/think` opens a picker containing only the thinking levels Pi reports for
  the current model
- Other slash commands mirror the gateway registry: `/status`, `/session`,
  `/new`, `/task`; `/clear` clears this local chat view
- An empty history shows a short fresh-session hint with useful commands

## Window behavior

- **Focused** → minimized in place (position, size, and maximize state are
  preserved by the compositor)
- **Not focused** (open on any workspace, or minimized) → brought onto the
  current workspace, raised, and focused
- **Full app restart** → restores the last normal width/height and maximize
  state from `$XDG_CONFIG_HOME/agent-gui/window-state.json`. Wayland does not
  expose global coordinates to GTK clients, so exact position persistence is
  intentionally handled only while the compositor surface remains alive.

## Launcher key setup

The client is toggled from a global keybinding. A typical setup is keyd (to
remap an otherwise-unused hardware key to a clean chord) plus a compositor
grab such as labwc:

1. **keyd** remaps the hardware key to a chord such as `Ctrl+Alt+K`.
2. **labwc** grabs the chord and performs the toggle: minimize the focused
   window; otherwise move any existing instance to the current workspace and
   focus it; launch one when no matching window exists:

   ```xml
   <keybind key="C-A-k">
     <action name="ForEach">
       <query identifier="agent-gui"/>
       <then>
         <action name="If">
           <query focused="yes"/>
           <then>
             <action name="Iconify"/>
           </then>
           <else>
             <action name="SendToDesktop" to="current" follow="no"/>
             <action name="Raise"/>
             <action name="Focus"/>
           </else>
         </action>
       </then>
       <none>
         <action name="Execute" command="/absolute/path/to/clients/gtk/toggle.sh"/>
       </none>
     </action>
   </keybind>
   ```

The window can be centered on first spawn via a compositor window rule
matching the deterministic app_id set by `GLib.set_prgname("agent-gui")`:

```xml
<windowRule identifier="agent-gui">
  <action name="AutoPlace" policy="center"/>
</windowRule>
```

Ctrl+T is handled inside the app (a window `key-press-event` handler) — no
global shortcut is registered for it.

After changing the keyd mapping or compositor config, apply with
`sudo keyd reload` and a compositor reconfiguration (`labwc --reconfigure`).

## Protocol

Standard gateway WebSocket messages (see `docs/ARCHITECTURE.md`).

Sends: `prompt` (with optional `streamingBehavior` of `steer` or
`followUp`), `abort`, `get_state`, `get_history`, `get_models`,
`switch_model`, `get_thinking_levels`, `set_thinking_level`, `command`,
`extension_ui_response`.

Renders: `connection`, `state`, `models`, `thinking_levels`,
`thinking_level_changed`, `model_switched`, `user_message`, `text_delta`,
`thinking_delta`, `thinking_done`, `tool_start`, `tool_output`, `tool_end`,
`done`, `response_segment_done`, `queue_update`, `prompt_accepted`,
`prompt_queued`, `abort_complete`, `error`, `notify`, `extension_error`,
`extension_ui_request`, `extension_ui_resolved`, `proactive`, `history`,
`usage`.

The client reconnects automatically if the gateway drops, reloads history
on each connect, and treats pushed `state` events (including `sessionId`,
`contextTokens`, `isProcessing`, and `working`) as authoritative. Errors
render in red. Pi `select`/`confirm`/`input`/`editor` dialogs (question
tool, permission-gate, plan mode, goal) appear as an interactive panel
above the composer.

## Tests

```bash
python3 -m pytest clients/gtk/tests/ -q
```

Run from the repository root so the `clients.gtk.*` imports resolve. The
tests are headless (no display required) and exercise the extracted logic,
not the GTK widgets.
