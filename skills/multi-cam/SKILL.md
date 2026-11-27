---
name: multi-cam
description: Sync multi-camera angles and separate audio tracks, identify each camera and speaker, and cut between angles with natural pacing for podcasts, interviews and conversations.
category: Story and pacing
---

# Multi-camera editing

Cut a multi-camera podcast, interview or conversation so the viewer stays inside the exchange rather than noticing the camera switches.

## Sync and sound first

- Sync every camera angle and separate audio track onto aligned tracks before cutting dialogue or switching shots (`timeline_sync_multicam`, with `audio_sync` if a track needs closer inspection).
- Keep the clean microphones audible and mute camera scratch tracks so room tone and voice quality stay steady across every picture cut.
- When a recording drifts or drops frames, keep the measured drift speed or steady parts rather than letting lips slip out of sync later in the show. Ask the editor for a sync point when a silent camera has no shared sound to match.
- Multi-cam works cleanly alongside `/dialogue-pass`: when also trimming pauses, retakes and false starts, run `/dialogue-pass` on the synced timeline first so every angle and microphone stays locked together through the cuts, then switch angles on the tightened rhythm. Switching first and trimming dialogue afterward (or re-switching a stretch later) keeps every track aligned too.

## Know each angle and voice

- Match speakers and microphones to camera angles before cutting (`multicam_analyze`). Confirm close calls with a quick look at frames (`media_frame` or `frame_contact_sheet`) when two single-person cameras look similar or a face sits in profile.
- Identify which camera is each speaker's close-up and which is the wide or two-shot showing everyone in the room.

## Switching rhythm and pacing

- **Open on the room.** Start on the wide or two-shot for a few seconds to establish who is talking and where they sit, then move into close-ups as the conversation settles in.
- **Follow the thought, not every syllable.** Stay on the active speaker through their point. Do not ping-pong back and forth for brief one-word backchannels ("yeah", "right", "mm-hmm") — hold the speaker or go to the wide shot instead.
- **Give each shot time to breathe.** Let most angles hold for several seconds (roughly 4 to 12 seconds as a guide: shorter during brisk banter, longer during a focused story). Never cut to an angle for under a second.
- **Motivate cuts with subtle L-cuts and J-cuts.** Because audio plays continuously underneath the picture, a switch does not have to land on the exact first syllable of a turn. Carrying the end of a question or punchline over the listener's face for half a second to a second (an L-cut) lets the viewer see the reaction land; letting the next voice begin a fraction of a second before cutting to them (a J-cut, about a quarter of a second) makes the switch feel natural and unhurried.
- **Earn your reaction shots.** During a long answer, an occasional cut to the listener nodding, smiling or reacting keeps the conversation alive without stealing focus from the speaker.
- **Use the wide shot when the room shares the moment.** Cut back to the wide or two-shot for crosstalk, overlapping banter, shared laughter, topic resets, intros and outros, or whenever someone gestures toward another person.
- **Match the brief.** A high-energy debate or social clip cuts faster; a thoughtful long-form interview holds longer and leans more on reaction holds.

`timeline_sync_multicam`, `multicam_analyze`, `timeline_switch_cameras`, `audio_sync`, `faces`, `lip_sync`, `media_frame` and `frame_contact_sheet` cover what this needs.
