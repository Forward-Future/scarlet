---
name: dialogue-pass
description: Make a first dialogue cut by removing abandoned starts, redundant takes, production talk and pauses that interrupt the speaker’s flow.
category: Story and pacing
---

# Dialogue pass

Make the conversation easier to follow with cuts alone. Keep the speaker’s meaning, the order of the exchange and the timing between synchronized tracks. The editor’s brief sets the pace and identifies any passage to protect. Mixing, color, framing, cutaways, music, captions and smoothing effects each need an explicit request.

An abandoned start can come out when the next take completes the thought. A retake can begin just beyond the passage under review. Compare what each delivery actually says, particularly corrections, qualifications and changes of mind. Keep repetition used for emphasis and the other speaker’s reply. A direction to the recording crew can come out when the surrounding dialogue makes its purpose clear.

When a line is barely audible beside the dialogue on either side, usually cut the whole line and the wait around it. Keep a deliberate whisper or a quiet reply the audience needs to follow the exchange.

Match a pause to the exchange around it. Leave room for someone to think, react, breathe or show the audience what they mean. A filler can carry hesitation or hold a speaker’s turn. Use the words, measured sound and picture to decide whether removing it helps. A gap in the transcript can contain speech or action. With `/tighten-pauses-here`, consider only pauses in the requested passage.

Use `dialogue_apply_cuts` to record cut, keep and review decisions on the working edit. Mark a meaningful pause or protected phrase as a keep. For staged cuts, use `dialogue_review_inspect` and `dialogue_review_save` to record a recommendation. If two readings remain plausible, name the words or reaction that would change and leave the choice to the editor.

Check the joined dialogue in context. Each speaker’s words should play whole, with questions and answers still making sense together. On a full pass, use `dialogue_check_repeats` to catch clipped words and accidental restarts introduced or left behind by the cuts. Finish when the requested dialogue cuts and their review are ready.

Acoustic filler detection is [Powered by Desert Ant Labs](https://desertant.com/).
