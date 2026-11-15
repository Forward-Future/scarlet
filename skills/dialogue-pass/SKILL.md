---
name: dialogue-pass
description: Make a first dialogue cut by trimming distracting pauses, fillers, redundant takes and production talk while preserving the speaker’s flow.
category: Story and pacing
---

# Dialogue pass

Make the conversation easier to follow with cuts alone. Keep the speaker’s meaning, the order of the exchange and the timing between synchronized tracks. The editor’s brief sets the pace and identifies any passage to protect. Use straight picture and audio cuts. Smoothing, mixing, color, framing, cutaways, music and captions each need an explicit request.

An abandoned start can come out when the next take completes the thought. A retake can begin just beyond the passage under review. Compare what each delivery actually says, particularly corrections, qualifications and changes of mind. Keep repetition used for emphasis and the other speaker’s reply. A direction to the recording crew can come out when the surrounding dialogue makes its purpose clear.

When a line is barely audible beside the dialogue on either side, usually cut the whole line and the wait around it. Keep a deliberate whisper or a quiet reply the audience needs to follow the exchange.

Cut tight. A pause earns its length by doing something: a beat before a reveal, a reaction, a breath between two ideas, time to take in what just appeared on screen. A pause that only waits comes down to the beat the delivery around it needs: next to nothing inside a sentence, a little more between sentences, more again where the subject changes. The quiet either side of a join plays as one pause, so judge the air left after the last word and before the next together, as it will be heard; between lines of one thought, about a quarter to a third of a second is a guide, not a rule. As a guide, not a rule, half a second or more with nothing happening in it plays as dead air. When nobody is speaking, keep only as long as the viewer needs to see the result: typing, loading, searching and waiting cut to the moment the result appears. A sigh, a cough, a lip smack or a throat-clear between lines goes out with the wait around it. So does a sound that isn’t the speaker’s, such as a system chime or a remark from someone off-mic, when nothing the audience needs is said over it. Cut an “um” or “uh” when the line flows better without it. A filler can also carry hesitation or hold a speaker’s turn. Use the words, measured sound and picture to decide. A gap in the transcript can contain speech or action.

Apply confident cuts with `dialogue_apply_cuts`. Mark a meaningful pause or protected phrase as a keep. When removing a passage could change the meaning or lose a reaction, stage the cut for the editor. Use `dialogue_review_inspect` and `dialogue_review_save` to record a recommendation that names the words or reaction at stake. Keep a passage when it belongs in the video. If the right take loses its first or last word at a splice, its neighboring words can anchor a better cut. A repair succeeds when the unwanted passage is gone and the intended sentence plays whole.

Judge the dialogue that plays, including stretches that run straight through. An abandoned take or direction to the crew can survive inside one clip. The kept timeline transcript and playback can resolve whether a repetition adds emphasis or starts the same thought again. Each speaker’s words should play whole and questions and answers should still make sense together.

When a picture cut returns to a speaker, the brief sets how quickly their voice should enter. `timeline_join_audit` reports the time from the incoming picture to the first word of that take. Use the sound around its onset to judge a trim, especially for quiet consonants or a word that begins before the picture changes.
