---
name: music-under-speech
description: Dip music under speech so every word sits clearly on top, and let it come back up in the pauses and where nobody speaks.
category: Sound
---

# Music under speech

Music that plays at one level either buries the words or sounds thin where nobody speaks. Dipping it while someone talks, and bringing it back up when they stop, keeps the words clear and the music full.

- How deep: usually about 18 dB under the music's own level while someone speaks, as a guide, not a rule. A busy track, or one with singing, needs more, since its own words and melody compete with the speaker's; a quiet pad under a calm voice needs less. Listen for the speech sitting clearly on top without the music vanishing.
- Going down: usually over about 0.3 s, finishing as the first word starts, so the first word never fights the music. A guide, not a rule: a soft entrance can take longer.
- Coming back up: usually slower, about 0.8 s once the line ends, so the swell feels like a breath rather than a jump. A guide, not a rule.
- Pauses: let the music come back up only in a pause of about two seconds or more, as a guide, not a rule. In shorter ones the level pumps up and down, and the viewer hears the mixing instead of the music.
- Where nobody speaks, such as an intro, a demo with no talk, or the end, the music plays at its own level.
- One dip pass over a music track is one edit.

After it's placed, listen at the first word after each swell and at the end of each long dip.

A `duckUnderSpeech` step in `timeline_propose` places the dips from the speech the transcript has, and `timeline_transcript` shows where the speech is.
