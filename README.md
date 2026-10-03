# Metamorpheme

**Superpose meanings that coincide. Equivocal by design.**

![what-you-define](assets/what-you-define.gif)

Linguistically, we like to think words have strict definitions. But in actual communication, words function exactly like clouds of states. They exist in superposition until context forces them to resolve.

![Say/Mean what you mean/say](assets/say-what-you-mean.gif)

## Syntax

Default separator is `;`:

```
{~ align=justify ; Prolix ; Verbose ; Diffuse ~} & {~ laconic ; concise ~}.
{~ Con ; Sub ; Pre ~}text: text was never just text.
{~ This ; that ~} ain't {~ that ; this ~} or is it ?
What you {~ can't quite ; won't yet ; may never ~} say.
{~ Unsaid ; Unspoken ; Untold ~} doesn't mean left out.
{~ Leave ; Make ; Find ~} space for what one word couldn't carry.
Not ur {~ typical ; regular ; boring ~} or.
For {~ hold=2 fade=1 align=left style=crossfade ; thought @3 ; idea @1.5/0.4 ~} that still has {~ many ; too many ~} names.
```

- Keep a space after `{~` and before `~}`.
- `word @H` — this word stays H seconds before the next one fades in.
- `word @H/F` — same, and the morph into the next word takes F seconds.
- `word @/F` — only override the fade.
- First segment `hold= fade= style= align=` sets defaults for that set (`align`: left | center | right | justify). `justify` stretches shorter morphemes to the width of the longest one in the set.
- Styles: `zoom`, `diffuse`, `slide`, `crossfade`. The default is chosen in plugin settings; `style=` overrides it per set.
- Markdown inside a set still works, including a separate link on each morpheme: `{~ [[draft]] ; [[note]] ~}` or `{~ [one](url) ; [two](url) ~}`. Wrapping the whole set (`**{~ thought ; idea ~}**`) applies to every morpheme.

## Commands

- **Insert morph set** — assign a hotkey in Settings → Hotkeys. On a phone it is also in the formatting row above the keyboard. If the selection is a slash or pipe list (`a|b|c` or `a/b/c`, including markdown links), it becomes `{~~}`. Otherwise it wraps the selection, or inserts an empty set.

