---
name: add-captions
description: Caption the current edit using the active style guide and short, readable lines.
category: Picture and graphics
---

# Caption the edit

Caption the speech that is still in the edit, so a viewer with the sound off follows every line without rereading. The brief, the active style guide, and the picture decide the wording, placement and style.

## The look

- When a style guide is provided (the editor's default style, an `@style` mentioned in chat or a skill, or the project's guide), follow it as written for captions: its font family (or attached font file path), font weight, size, text color, accent/highlight color, box/background, outline, uppercase choice, and position. Pass those in `captions_generate`'s `style` (or `timeline_propose`'s `captionStyle`). Where the guide is silent, stay in the spirit of its palette and typography rather than inventing an unrelated look.
- With no style guide, keep captions clean and legible over the footage: one plain sans-serif, high contrast, with a subtle outline or dark backing box whenever the picture behind them is bright or busy.

## Wording and pacing

Caption what is said, as it is said. Correct what the transcript misheard, above all names, products and numbers, and leave the speaker's grammar alone. A filler the edit kept can stay out of the caption when it carries no meaning.

Break lines where a reader would pause: at the end of a phrase, never between a name and the rest of it, a number and its unit, or an article and its noun. Keep a caption to one or two short lines, roughly 32 to 42 characters each, so at most about 80 characters and 14 words, and on screen long enough to read, around 15 to 17 characters a second, which can mean holding it a little past the words. End a caption with its sentence, and start a new one when the speaker or the shot changes rather than carrying one across it.

Keep captions clear of faces, on-screen text and anything the viewer needs to see. A caption that has to move for one shot can move; the style stays the same throughout.

`captions_generate` builds the track from the kept words, `timeline_propose` edits single cues, and `frame_contact_sheet` shows them on the picture.

When the editor supplies plain SubRip text timed to this cut, pass the original contents to `captions_import_srt`. It adds a separate editable track and keeps the supplied wording, line breaks, and times.
