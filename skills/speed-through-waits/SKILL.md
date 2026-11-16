---
name: speed-through-waits
description: Play waits in a screen recording fast instead of cutting them, so the viewer sees the work happen, such as installs, builds, renders, generation and loading.
category: Story and pacing
---

# Speed through waits

When nobody speaks and the screen shows work in progress, playing it fast keeps the sense that time passed and shows the result arriving, where a cut makes it look instant. Speed up a wait when watching the progress tells the viewer something: a progress bar, text streaming in, a build log scrolling, a page filling in. A wait where nothing changes on screen is better cut.

- A sped-up wait is over in a few seconds whatever its length, about two to five on screen as a guide, so a long render plays much faster than a short install.
- It starts once the speaker has stopped talking and ends just before the result appears or they speak again, so the result itself plays at normal speed.
- Speech is never sped up. If the speaker talks during a wait, those words play at normal speed and the stretches either side speed up.
- The sound of a sped-up stretch is muted: fast keyboard clatter and fan noise only distract.
- Every synchronized track speeds up together, so the camera stays in sync with the screen.
- Each sped-up wait is one edit.

`dialogue_scan`, `screen_text`, `frame_contact_sheet` and `timeline_propose` cover what this needs.
