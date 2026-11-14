---
name: dialogue-pass
description: Make a first dialogue cut by trimming distracting pauses, fillers, redundant takes and production talk while preserving the speaker’s flow.
category: Story and pacing
---

# Dialogue pass

Make the conversation easier to follow with cuts alone. Keep the speaker’s meaning, the order of the exchange and the timing between synchronized tracks. The editor’s brief sets the pace and identifies any passage to protect. Mixing, color, framing, cutaways, music and captions each need an explicit request.

An abandoned start can come out when the next take completes the thought. A retake can begin just beyond the passage under review. Compare what each delivery actually says, particularly corrections, qualifications and changes of mind. Keep repetition used for emphasis and the other speaker’s reply. A direction to the recording crew can come out when the surrounding dialogue makes its purpose clear.

When a line is barely audible beside the dialogue on either side, usually cut the whole line and the wait around it. Keep a deliberate whisper or a quiet reply the audience needs to follow the exchange.

Aim for a natural pace. Shorten a pause that only holds up the next line. The quiet either side of a join plays as one pause, so judge the air left after the last word and before the next together, as it will be heard; between lines of one thought, about a quarter to a third of a second is a guide, not a rule. Leave room for someone to think, react, breathe or show the audience what they mean. Cut an “um” or “uh” when the line flows better without it. A filler can also carry hesitation or hold a speaker’s turn. Use the words, measured sound and picture to decide. A gap in the transcript can contain speech or action. With `/tighten-pauses-here`, consider only pauses in the requested passage.

Apply confident cuts with `dialogue_apply_cuts`. Mark a meaningful pause or protected phrase as a keep. When removing a passage could change the meaning or lose a reaction, stage the cut for the editor. Use `dialogue_review_inspect` and `dialogue_review_save` to record a recommendation that names the words or reaction at stake.

Smooth a change in room tone at a dialogue join with a centered two-frame audio crossfade. Keep the picture cut straight. Set `crossfadeFrames` when submitting cuts with `dialogue_apply_cuts`. When assembling kept takes with `timeline_first_cut`, add the overlap at their joins with `timeline_crossfade_audio` once the assembly is applied. Follow the editor’s preference for another length or straight audio cuts.

Check the joined dialogue in context. Each speaker’s words should play whole, with questions and answers still making sense together. On a full pass, use `dialogue_check_repeats` to catch clipped words and accidental restarts introduced or left behind by the cuts. Finish when the requested dialogue cuts and their review are ready.

Acoustic filler detection is [Powered by Desert Ant Labs](https://desertant.com/).
