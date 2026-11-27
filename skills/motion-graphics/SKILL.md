---
name: motion-graphics
description: Make motion graphics — full-screen explainers and titles, or overlays on A-cam — that read well on this footage, cohesive with the project's style.
category: Picture and graphics
---

# Motion graphics

A graphic is there to clarify or illustrate what's being said, then get out of the way. Make each one legible on the footage it sits on, cohesive with the project's look, and on screen only as long as it earns.

## The look

- When a style guide is provided (the editor's default style, an `@style` mentioned in chat or a skill, or the project's guide):
  - For **title cards, chapter titles, lower thirds, callout boxes, and end cards**, follow it closely: its fonts, colors, sizes, placement, motion, and attached brand assets. Where it is silent, keep to the spirit of what it says.
  - For **custom or illustrative motion graphics** (diagrams, visual explainers, animated concepts), treat it loosely as inspiration rather than a strict spec: echo its overall mood, typography feel, or accent touches so the graphic feels at home in the video, while letting the concept drive the composition, colors, illustration, and motion instead of forcing rigid templates, fixed margins, or color ratios.
- With no guide, take the look from what the editor has already approved in this project, so every graphic in a video reads as one family. A first graphic with nothing to go on stays plain: one clean sans-serif, white or near-black, one accent at most.

## Full-screen vs. overlay on A-cam

- Choose deliberately between a **transparent overlay on the A-camera** and a **full-screen graphic** — don't default to opaque full-screen slides for everything, and don't cram a complex visual into a tiny corner.
- **Use an overlay on A-cam (`background: transparent`)** when seeing the speaker carries the moment or the graphic is a focused companion to what they are saying: lower thirds, names and roles, a key stat or big number, short callouts, simple 2–3 point lists, compact comparisons, or quick visual accents. Place it in open space clear of the speaker's face, eyes, mouth, and silhouette; on a centered talking-head shot that needs room beside the speaker, smoothly slide/reframe the A-camera to make space rather than covering them or turning the graphic opaque.
- **Go full-screen (opaque canvas)** for chapter titles, full-frame title cards, end cards, and complex or spacious motion graphics — multi-step diagrams, detailed animated explainers, simulations, code/UI flows, or rich illustrations that genuinely need the full 16:9 frame to stay readable and breathe. Avoid cutting away from the speaker on the line where their expression carries the point, and avoid stacking opaque full-screen graphics back-to-back without returning to camera.

## Legibility on the actual picture

- For overlays, check the graphic over the frames it will sit on, at the moment it is fully in. Text should hold its contrast against the brightest and busiest part of the picture behind it; add a backing panel or a soft shade when the footage won't give it that.
- Keep overlays clear of faces, eyes and mouths, of text already burned into the picture, and of anything the viewer is meant to be looking at. A lower third sits low and to one side, inside the frame's safe margins, never over the speaker's chin.
- Size for the screen the video will be watched on (including phones): titles and key labels large enough to read at a glance, secondary lines smaller but never squinting size.

## Timing

- Bring a graphic in on a beat: as a person is introduced, as a point is made, on a cut. Not mid-word, and not in the same instant as another change on screen.
- Hold it long enough to read twice at a relaxed pace, about three seconds for a name and role, longer for more words, then take it off before it overstays. Leave it off the last moments before a cut unless it is meant to carry across.
- For titles, lower thirds, and callouts, keep motion quick and quiet: a short ease in and out, a few tenths of a second, with nothing that bounces, spins, or competes with the speaker. For custom explanatory motion graphics, animate purposefully to show the concept in motion while staying clear and easy to follow.

## Restraint

One graphic at a time, and only where it helps the viewer: who is speaking, where we are, a figure worth seeing. When in doubt, leave it out and say so to the editor.

`graphic_render`, `graphic_get` and `timeline_propose` cover what this needs.
