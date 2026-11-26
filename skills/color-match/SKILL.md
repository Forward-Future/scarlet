---
name: color-match
description: Match exposure, white balance and contrast across cameras, or apply the active style guide's saved color look consistently across the edit.
category: Picture and graphics
---

# Color matching and camera looks

Good grading disappears: cuts between cameras feel like one room and one lens, skin tones stay natural, and the look serves the footage instead of drawing attention to itself.

## Start from what is on screen

- Inspect clean, representative frames from each camera source before changing anything. Pick moments where the speaker's face and neutral surfaces (white paper, gray walls, desk) are well lit and not mid-motion.
- When an active style guide includes a saved color look or `.cube`/`.3dl` look file, start from that look and adjust per camera only as much as each angle needs to sit seamlessly inside it.
- When matching multiple cameras without a saved look, pick the best-exposed main camera (usually the primary talking-head angle) as the reference and bring the other angles to meet it rather than grading every camera independently.

## Order of adjustments

- **Exposure and contrast first.** Match overall brightness and shadow/highlight rolloff before touching color, since luminance shifts change how saturation and warmth read.
- **White balance next.** Compare neutral surfaces and skin tones side by side across a cut. Use warmth for amber/blue bias and tint for green/magenta cast (common under mixed studio LEDs or daylight windows).
- **Shadows, highlights, and saturation last.** Recover hot windows or foreheads with highlights, open crushed darks gently with shadows, and nudge saturation only enough to match color richness across angles.
- Keep moves small and cumulative. If a camera needs a heavy push, check that skin tones never turn orange, magenta, or muddy green and that darks stay clean.

## Consistency and verification

- Apply the same grade to every clip from the same camera source across the edit so a shot never shifts color mid-scene, unless the lighting itself changed in that room.
- After proposing the grade, inspect frames on either side of a camera cut (or before and after the look) to confirm skin tones, contrast, and brightness match.

`media_frame`, `frame_contact_sheet`, and `timeline_propose` (`updateClip` with `color`, `whiteBalance`, `shadowsHighlights`, `exposure`, `colorBalance`, or `lut` effects) cover what this needs.
