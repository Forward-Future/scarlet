# Changelog

What changed in Scarlet, newest first, in the words an editor would use. Scarlet shows this list in Settings › About, and the update button's hover lists the lines a waiting update adds.

Add one line under today's date for each change an editor would notice. Leave out changes to tests, builds and tooling.

## November 15, 2026

- Applying an edit that moved or re-added a clip after you cut inside it no longer leaves two clips playing over each other.
- Renaming your first-cut dialogue skill keeps its new command working as a dialogue pass.
- Scarlet can measure the wait between a picture cut and the next spoken word when you ask it to tighten an entrance.
- Scarlet now uses all its editing tools on every request: frame inspection, edit comparison, captions and import/export can no longer be turned off. Settings › Tools & skills lists the tools below your skills.
- A message you're writing about the whole video stays that way when you click or scrub the timeline.
- A time you type in your message no longer replaces the moment you picked, and taking the moment off with × keeps it off.
- The first thing you add to an empty message box now shows its card for a moment before folding into the icon, and the card opens the same way on every computer and closes when you click elsewhere or press Esc.
- A call you made on a dialogue pass no longer shows as unsaved after it was saved.
- Dismissing a short's "New project" note keeps it dismissed.
- Words you're changing on a queued request in one project no longer replace the ones you were changing in another.
- The Transcript now says when a recording is still being added, waiting, transcribing or has no transcript, instead of showing an empty column.
- Searching the Transcript for words with a dash or other mark in them no longer underlines the word after each match, and hovering a word shows its time, since a click places the playhead there.
- On a skill's page, hovering a template or skill named twice shows its note at the one under the pointer.
- The Model list no longer loses a computer that came online while it was refreshing.
- A cut named by its words is no longer placed on the wrong spot when the video plays the same take twice.
- Two requests about the same edit no longer run at once, and requests about different edits of one request no longer wait for each other.
- A cut's edge that would have caught the start of the next word now lands on a quiet frame, including when you revise a cut.
- A punch-in or title saved at a cut's join no longer replaces that cut's description.
- An edit another request flagged now shows as it is after it was revised, not as the version it replaced.
- Footage a cut took out is no longer counted twice when two edits name its join.
- An edit inside a selected passage is no longer refused when a tiny cut just before it was rounded to a whole frame.
- A graphic or template that uses a picture with a space or a % sign in its name now keeps that picture, and saving a style guide or template that fails part-way keeps the one you had.
- Graphics keep their exact colours when laid over the video, and stopping a graphic while Chrome is starting or loading stops it at once.
- Make shorts now copies only the footage your video uses, no longer slows Scarlet down on drives that can't share files, and a failed run leaves nothing in the Trash.
- Shorts made before a recording finished transcribing no longer each start their own transcription the next time Scarlet opens.
- Clearing cached renders while a preview is being made no longer breaks that preview.
- An edit Scarlet doubts is no longer flagged twice when a stopped request is resumed.
- Approving an edit no longer brings back footage that was cut since, whatever form the edit takes.
- Playback previews keep working when the hardware encoder fails, by switching to the software encoder.
- A transition from a colour card now plays instead of staying a straight cut.
- In a project handed to Final Cut, Resolve or Premiere, a hidden track that is still heard comes in as sound only, crossfaded sound uses two tracks instead of one more per join, pictures and graphics come in as stills, clips at another speed line up on whole frames, and the Read me lists each transition, since they come in as straight cuts.
- Media files with names Windows can't use are renamed in a hand-off so the timeline still finds them.
- Stopping Scarlet on Windows no longer leaves a request stuck as running when a program it started keeps going.
- Removing a file Scarlet couldn't read now also clears what it saved while timing the words of a Spanish recording.
- Type `/matt-talking-head` to edit in Matt Berman’s style, with tight dialogue, camera punch-ins and close-ups of what you show on screen.
- The timeline is quieter: with no request picked it shows only the video, and a picked request's edits are numbered, crowded ones grouped in runs like 15–27. Click a run to zoom into it; hovering shows just the frame, plus one amber line when something needs you.
- A file you add from a link is named as it is, without %20 and other codes.
- Drag up from the picture strip or waveform to see neighboring frames, then move sideways to scrub one frame at a time.
- The timeline hover preview keeps its picture in view while the next frame loads.
- Export › Advanced export saves a folder for finishing the edit in DaVinci Resolve, Final Cut Pro or Premiere Pro: the timeline with its cuts, tracks, zooms, volume and fades, a copy of the footage, the captions, and a Read me that lists anything that doesn't carry over.
- In the project library, a project whose caching you paused says Importing paused instead of still importing its files.
- Recordings of your spoken notes are no longer deleted the day after you save them.
- Transitions: type $ to pick one, like a swipe, whip pan, dissolve or dip to black, and see it play on your own footage before you ask for it. Each transition Scarlet adds is an edit you can revise or undo.
- Write a transition into a skill, like "every time I go to the screen recording, use $swipe": $ lists your templates in a skill's page too, and the templates and skills a skill names are marked so you can tell them from plain words.
- Type a timestamp like 1:42 in a new edit request to mark it on the timeline. Click it to jump there, or send the note about that moment.
- The tokens a request has used now show in the chat by default; turn them off in Settings › Usage.
- Codex installed through Homebrew can start editing on macOS while keeping its sandbox.
- Scarlet now times Spanish transcript words against the recording, including words Whisper gave the same start and end time.
- Scarlet can finish checking a batch of dialogue cuts even when the audio takes several minutes to measure.

## November 14, 2026

- Scarlet can read the pages you ask for in a PDF style guide on Mac and Windows, including consecutive pages that look alike.

- Ask Scarlet for a motion graphic, like a lower third or a title, and it makes one in your style and lays it over the picture as an edit you can revise.
- Type $ in the message box to pick a saved graphic template, with a preview of each on your picture.
- Save a graphic as a template with the bookmark on its card.
- Drop a style guide in the chat and say so: Scarlet follows it for every graphic in that project, and asks when a font it names isn't installed.
- Files dropped on the message box ride with your next message.
- The timeline shows every edit in the stretch you're looking at, and gathers them into counts like "9 cuts" on the whole video.
- After a dialogue pass, joins Scarlet couldn't listen to in a recording in another language are no longer counted as checked.
- A spoken note still being cleaned up when its project goes to the Trash is no longer saved into that project.
- A pause Scarlet trims on a sped-up or slowed-down clip plays as long as asked.
- When Claude Code can't reach Scarlet's editing tools, the request now ends as Couldn't finish with Retry instead of looking finished.
- Approving a trim that waited while you cut elsewhere no longer brings back footage you cut or leaves clips on top of each other.
- Scarlet lets you know when a new version of your edition is ready to download.
- On Mac and Windows, stable Scarlet downloads each published update and offers Restart to update when it’s ready.
- A rule you approve stays saved if Scarlet stops after updating the skill.
- An edit another request flagged can be revised and undone from the request that flagged it.
- With a marked range's handle focused, ← and → keep stepping it a frame at a time, Esc takes off only the range, and Space plays.
- A queued request being reworded keeps its new words after Scarlet restarts.
- Token counts in the chat stay put when Scarlet reconnects.
- A slash command with no matching skill sends on Enter and says why it couldn't run.
- The Model row stops saying "Connecting…" after a brief hiccup at launch.
- Approve waits for a skill to be chosen when a learning's skill was deleted, and a skill can't be deleted while Scarlet revises it.
- Hovering the update button shows what's new once the update has finished downloading.

- Settings › About lists what changed in each update, and hovering the update button says what the new build brings.
- Media says why an import won't be transcribed, and links straight to the fix.
- The transcript marks words and sounds picked up by a microphone the dialogue isn't on.
- Cut edges move past a stray sound at the join instead of keeping it.
- The dialogue pass cuts dead air and stray sounds as well as repeated takes.

## November 13, 2026

- Mark a range on the timeline's ruler and ask about just that part in the message box.
- Scarlet ships with three skills to start from: the dialogue pass, captions and screen framing.
- Cut edges land on quiet frames, so a cut no longer clips the first or last sound of a word.
- Scarlet reads the text on screen in a recording.
- After listening to a cut, playback carries on, and the next cut to open is the next one you haven't kept.
- Scarlet says when it nudged a cut edge to make room for the cut beside it.
- Scarlet runs on Ubuntu 24.04, with voice input.
- When a cut from a pass is open, footage that later parts of the pass took out is shaded and skipped.
- A word left alone between two dialogue cuts is checked by ear before the cuts apply.
- Usage reports can be turned off in Settings › About.
- A finished request's summary in the chat opens its edit in one click.
- Exports run in the background while you keep editing, and use hardware encoding whenever they can.
- Dialogue cutting preferences live in the dialogue pass itself, where you can edit them.
- Before and After play straight through a cut's join.
- Transcription uses the GPU, and Media shows each file's progress.
- An interrupted transcription picks up from where it stopped.
- Review items stay put while Scarlet works.
- Your first import offers a first cut you can edit.
- Faint dialogue is caught, and the selected cut stays in view while the video plays.
- Partial repeats of a word across a crossfade are found and cut.
- Scarlet is open source.
