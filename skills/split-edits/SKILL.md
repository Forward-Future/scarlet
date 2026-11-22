---
name: split-edits
description: J and L cuts, where a join's sound leads or trails its picture, so conversations, interviews and reactions flow across the cut instead of switching sound and picture on the same frame.
category: Story and pacing
---

# Split edits

A straight cut changes picture and sound on the same frame. A split edit moves the sound cut off the picture cut: in a J cut the next shot's sound starts a little before its picture, so the viewer hears the new voice and then sees who it is; in an L cut a shot's sound carries on a little after the picture has changed, so a line lands over the listener's face. Both make a cut feel like one conversation rather than a switch.

## Where it usually helps

- Between two people talking, an interview or a conversation shot from more than one angle: let the next speaker's voice lead into their shot, or let a line finish over the person hearing it.
- Into a reaction: carry the line on over the reaction shot, so the viewer sees it land while it is still being said.
- Into a new scene or location: let its sound arrive a moment early to pull the viewer through.
- Out of B-roll back to the speaker: let their voice come in under the last of the B-roll.

These are usually where a split earns its place. They are a guide, not a rule: the footage and the editor's brief decide.

## Where to leave the cut straight

- A jump cut inside one person's talking head, where both sides are the same shot of the same voice: there is nothing to lead into, and the speaker's own words would just overlap or drop.
- A cut placed on a hard beat, a punchline or a reveal, where the snap of sound and picture changing together is the point.
- Where the extra sound would bring back words or noise a cut took out, or lose words the viewer needs: the result says which words a split brings in and takes away.

## How far

- A voice leading into a cut usually needs only a quarter of a second or so, about six to eight frames, enough to be heard before the face appears. A guide, not a rule.
- A line carried over a reaction often runs longer, half a second to a second, as long as the reaction needs to land.
- Each edge of the moved sound sits in a pause between words, never inside a word.
- Use them where they help, not on every join: a whole edit of split joins blurs every change of shot.

A `splitJoin` step in `timeline_propose` makes the split, and its result says when each voice comes in and goes out against the picture cut. `timeline_transcript`, `dialogue_check_join` and `timeline_join_audit` show the words and the quiet around a join.
