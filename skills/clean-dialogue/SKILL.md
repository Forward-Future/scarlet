---
name: clean-dialogue
description: Reduce background noise, correct voice tone or even out a speaker’s level on existing Scarlet clips.
category: Sound
---

# Clean dialogue

Correct sustained noise, tone or level on a microphone so the voice sounds like the person in the room, only clearer. The recording and the delivery brief decide the processing and its settings.

Listen to the speaker before reaching for a preset: each voice and room needs its own amounts, and each speaker in a conversation is treated on their own. Do the least that fixes the problem. Keep breaths and consonants; the edges of words carry intelligibility, and a voice with them gated or filtered away sounds processed. Stop short of pumping, swirling or a metallic tone, and of a room so quiet between words that it drops out and comes back with each line.

Compare the processed passage with the original. Speakers in one conversation should sit at a similar level, and the whole edit at the loudness its delivery calls for, with peaks that don't clip.

`media_profile` measures the source, `waveform_get` the levels over a passage, `timeline_propose` sets each clip's gain and effects, and `render_status` measures a rendered passage as processed.
