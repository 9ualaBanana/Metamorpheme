# Morph Text

Liquid morphing text between words, inspired by Magic UI's Morphing Text.

## Syntax

Inline (renders in Reading view and Live Preview):

    {~ Hello | World | Obsidian ~}
    {~ Hello @3 | World @1.5/0.4 | Obsidian ~}
    {~ hold=2 fade=1 align=left | one | two | three ~}

- Keep a space after `{~` and before `~}`.
- `word @H`   — this word stays H seconds before the next one fades in.
- `word @H/F` — same, and the morph into the next word takes F seconds.
- `word @/F`  — only override the fade.
- First segment `hold= fade= style= align=` sets defaults for that set (align: left | center | right).
- Styles: `morph` (liquid), `crossfade`, `blur`, `slide`, `zoom`, `scramble`. The default is chosen in Settings → Morph Text; `style=` overrides it for one set.
- In a Markdown table, escape the bars: `\|`.

Block form (one word per line, first line optional options):

    ```morph
    hold=2 fade=1
    Think
    Write
    Ship @4
    ```

## Commands
- **Insert morph set** — `Cmd/Ctrl+Shift+M`. Wraps the selection (lines, commas or bars become words), or inserts an empty set.
- **Insert morph block** — inserts a ```morph block.

Default style, hold and fade (with a live preview) are in Settings → Morph Text.
