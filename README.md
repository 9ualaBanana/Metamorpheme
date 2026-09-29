# Metamorpheme

**Superpose meanings that coincide.**

Linguistically, we like to think words have strict definitions in the dictionary. But in actual communication, words function exactly like clouds of states. They exist in superposition until context forces them to resolve. Take off the mental load of translating multidimensional ideas into shallow symbols.

![Say/Mean what you mean/say](assets/say-what-you-mean.gif)

Vague on purpose.

> Share {~ piece | peace ~} of your mind in its native language

Connect {~ notes | nodes ~} which you refer to by different names.

A note titled `{~ notes ; nodes ~}` morphs in the file explorer, tabs, and editor title. Inline `{~~}` sets morph in Reading view and Live Preview.

## Syntax

Inline (Reading view and Live Preview). The default separator is `;`:

```
{~ Hello ; World ; Obsidian ~}
{~ Hello @3 ; World @1.5/0.4 ; Obsidian ~}
{~ hold=2 fade=1 align=left ; one ; two ; three ~}
```

- Keep a space after `{~` and before `~}`.
- `word @H` — this word stays H seconds before the next one fades in.
- `word @H/F` — same, and the morph into the next word takes F seconds.
- `word @/F` — only override the fade.
- First segment `hold= fade= style= align=` sets defaults for that set (`align`: left | center | right).
- Styles: `morph` (liquid), `crossfade`, `blur`, `slide`, `zoom`, `scramble`. The default is chosen in plugin settings; `style=` overrides it for one set.
- Markdown inside a set still works: `{ ~ **Hello** ; [[World]] ~ }`. Wrapping the whole set (`**{~ a ; b ~}**`) applies to every morpheme.
- File names cannot contain `|`, so titles use the same `;` separator by default.

Block form (one word per line, first line optional options):

```
```morph
hold=2 fade=1
Think
Write
Ship @4
```
```



## Commands

- **Insert morph set** — `Cmd/Ctrl+Shift+M`. Wraps the selection, or inserts an empty set.
- **Convert slash or pipe list to morph set** — `Cmd/Ctrl+Shift+/`. Turns `a|b|c` or `a/b/c` (including markdown links) into `{~~}`.
- **Insert morph block** — inserts a `morph` code block.

Typing `{` still auto-closes `}` when **Settings → Editor → Auto pair brackets** is on. Typing `~` between `{|}` then inserts `{ ~ | ~}` with the cursor in the middle. Turn this off in plugin settings, or by disabling auto-pair brackets globally.

## Settings

Default metamorphosis style, hold, and fade (with a live preview), separators, title surfaces (editor, tab, explorer), rewrite-on-separator-change, and auto-close `{~~}`.