---
name: smooth-audio-cuts
description: Fix clicks or abrupt room-tone changes at existing dialogue joins in Scarlet while preserving picture timing.
category: Sound
---

# Smooth audio edits

Fix a click or a change of room tone at a join without moving the picture. The recording and the brief decide the transition.

A short centered audio crossfade is usually enough at a dialogue join. Reach further when a join still draws attention: a longer fade where the room tone changes, a shorter one where a word starts right after the cut, or a fade shaped differently on each side.

Listen at both ends of the fade. It should not clip the start or end of a word, double a syllable, or uncover a gap or a breath that was cut away. Keep intentional pauses as they are, and change nothing in the picture.

`timeline_crossfade_audio`, `timeline_propose`, `timeline_join_audit` and `timeline_diff` cover what this needs.
