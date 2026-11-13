---
name: smooth-audio-cuts
description: Fix clicks or abrupt room-tone changes at existing dialogue joins in Scarlet while preserving picture timing.
category: Sound
---

# Smooth audio edits

Fix a click or a change of room tone at a join without moving the picture. The recording and the brief decide the transition.

`timeline_crossfade_audio` overlaps the two clips at a join. `timeline_propose` sets clip gain and fades when each side needs its own shape. `timeline_join_audit` measures the result at each join, and `timeline_diff` confirms the picture timing and runtime are unchanged.
