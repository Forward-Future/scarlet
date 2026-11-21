# Changelog

What changed in Scarlet, newest first, in the words an editor would use. Scarlet shows this list in Settings › About, and the update button's hover lists the lines a waiting update adds.

Add one line under today's date for each change an editor would notice. Leave out changes to tests, builds and tooling.

## November 20, 2026

- A cut after you finish talking now comes right after your last word: a beat Scarlet keeps before a new demo or topic plays after the cut instead of as quiet after you stop.
- An edit you play no longer starts over when Scarlet saves another edit of the same request meanwhile: it plays on, and the new edit comes in when you pause.
- The model picker lists Standard speed once for Claude models instead of twice.
- A skill Scarlet comes with that you edited and then set back to Scarlet's own text gets Scarlet's updates again.
- When Scarlet puts your camera in the corner over a screen recording, it now frames you instead of shrinking the whole camera shot into the box, and follows your skill's size, shape, how much of you to show and rounded corners.
- An edit that frames a screen recording no longer waits behind itself: Scarlet looks at several of the recording's windows at once beside it, so those edits finish minutes sooner.
- With Gemini, a step that needs Scarlet to measure something first now waits for it instead of giving up and trying again.
- Crossfading a join or putting a recording's picture in time with its sound no longer moves its sound onto a dialogue track you muted, so those passages stay audible.

## November 19, 2026

- Scarlet can now check whether a recording's lips keep time with its sound and, when they're off, move the picture to match while every cut stays where you heard it.
- When the FFmpeg on your computer can’t draw text, exporting or playing a video with captions now says so and how to install one that can, instead of only asking you to try again.
- On Windows, each edit starts about half a second sooner: Scarlet no longer opens PowerShell to lock its working folders and keep track of the programs it runs.
- A cut whose edge Scarlet only had to move back into a pause, with no word in between, now goes in on its own instead of waiting for you as a call.
- On Windows, Scarlet's agent now locks its settings file, which holds the key to the engine, to your account each time it loads it, so another account on the PC can no longer read it through a permission left on the file itself.
- Export can save captions as SubRip (.srt) or WebVTT (.vtt) files.
- When you ask Scarlet to keep a video's original sound, it no longer plays that sound a second time on another track, which made it louder.
- Keeping one cut Scarlet hadn't checked no longer puts the other unchecked cuts in without asking you.
- With reduced motion on, the ring round the mic stays still while it records.
- Edits with a Gemini model now get all of Scarlet's editing tools and your whole skill, and keep working instead of stopping early as if they were done.
- When Scarlet asks to see several stretches of the footage, it now gets them together instead of asking again for the ones that weren't ready, which saves time and tokens on edits that look at the video.
- A transcript's progress now counts the last check for restarts and filler words, so it no longer sits at 100% while that check runs.

- Pause for media processing now appears only while files are actually being prepared, cached, or transcribed (and stays as Resume while paused).
- An edit Scarlet was working on when you quit or restarted says “Picking up where it left off” when Scarlet reopens, and Restart to update says beforehand that the edit carries on.
- Rejecting an edit no longer moves the timeline: its band fades where it is and the card says Rejected until you go on to another edit.
- The × on a moment's card rejects only the edit the card is named for, not every edit of the moment.
- A rejected edit's row can be pressed to see it again: the timeline goes to where it was and its card shows its note.
- A false start the transcript missed is no longer left in: Scarlet won’t shorten a “pause” it heard words in, and after each part of a pass it checks for words still playing that the transcript doesn’t have.
- Approving a call or keeping a flagged edit while on the See all list now moves to the next item in that list instead of skipping ahead to the next For you item.
- The Approve and Apply buttons now show their A shortcut inside the button, matching Keep and Revise.
- The Transcript column keeps its words up when an edit lands or a cut opens, instead of emptying to “Loading transcript…” and reading the whole transcript again.
- The talking-head skill leaves natural pauses alone again: a pause under about a second stays as said, and only longer dead air comes out.
- Hovering any of the picture-marking icons above the video explains what it does, and marks you place on a frame can now be grabbed and moved directly on the video.
- While you're still talking about a demo or reacting to it, your screen stays up instead of cutting to your camera; your camera comes back once you've moved on.
- Each model in the model picker sits on one line, with hidden models listed below the active ones.
- When you start a line over, the transcript now times the word you kept on the take you finished, so cutting the false start no longer takes that word with it (“now, now, if I had, now even if” kept its last “now”).
- A cut Scarlet saved without its own summary is named in the list by the words beside it (“Shortened the pause after “okay””), so a pass's rows no longer all read the same.
- A request's sentence says footage put back as “put back 1 passage”, not “made 1 passage put back”.
- A call you play while Scarlet is still editing plays straight through: the edits Scarlet saves meanwhile come in when you pause, as they do with nothing open.
- A screen insert that would end or start a moment after your recording switches window or page now changes on the switch, so another window no longer flashes up for a split second.
- A cut no longer starts a few frames late on a quiet word it means to keep, and the pass no longer stalls when a word is too quiet to find.
- The talking-head skill trims pauses the way a published cut does: a pause of about six tenths of a second or more comes out, shorter ones and beats held on purpose stay.

## November 18, 2026

- At the end of a dialogue pass Scarlet now picks out the cuts it thinks most likely to be wrong and puts them in For you, and a new setting, Checking with you in Settings, says how many: Less, Balanced or More.
- Pause, Resume and Stop are small icons together at the right of the request Scarlet is working on, named as soon as you hover them, and the time or cut your message is about shows on the line just above the message box.
- Templates are gone for now: the message box no longer lists them with $, and a graphic's card has no bookmark. Describe a look or a transition in a skill, or just ask for it.
- Rejecting an edit undoes it at once, with no wait and no tokens, whenever Scarlet knows exactly what the edit changed: a cut, a change to how a shot looks or sounds, or a request's only edit. It is out of the video and off the timeline as soon as you press ×. Scarlet is only asked for the rest.
- A rejected edit stays in its request's list with a × and "Rejected", and is no longer counted as a passage put back.
- While a video is still caching, Scarlet now says you can start editing without waiting for it.
- Zooming in on the timeline brings the playhead a little nearer the middle each time, so it no longer stays out at the edge.
- Each cut in a pass's list of edits now says what came out and where, such as "Shortened the pause after ‘okay’", instead of the same reason on every row.
- The drawing tools sit in a row above the video instead of over the picture.

- The drawing tools now stay over the top left of the picture, so a press on one pauses the video and starts marking; the pen beside full screen is gone.

- A dialogue pass leaves your own short pauses in and cuts only the ones that play as dead air, about a second or more, so cuts no longer land one after another.
- ⌘Z takes back your last Keep, Reject or revision, and pressing it again goes on to the one before. "Undo Keep", "Undo Reject" or "Undo revision" under the timeline says what it will take back.
- Scarlet now makes a cut between two words you say without a pause, where you'd cut it, instead of setting it aside.
- A cut Scarlet couldn't place cleanly is no longer swapped for a cut of different words without asking you.
- Transcripts no longer make up a word where a sentence runs across one two-minute stretch of the recording into the next, so Scarlet won't cut real lines to remove it. Videos transcribed before this update keep their transcripts until you transcribe them again.
- An edit's card has a small × after Keep again: Reject edit has Scarlet put that edit back and moves on to the next one.
- Pausing with a cut or an edit open shows the time you stopped on in the message box. The message is still about that cut or edit, and Scarlet knows which moment you mean.
- A click on the edge of the chat that doesn't drag it no longer fixes the chat's width, so it keeps following the window.
- Two-finger scroll and zoom on the timeline keep working after a pinch that ended while you were dragging.
- Space plays a Before again after its picture had to fall back to the saved clip.
- A folder saved for another editing app is no longer reported as failed when only its bookkeeping couldn't be written.
- The model list no longer goes blank after the engine restarts while a run is still stopping.
- Shorts Scarlet turned out not to need stop caching their footage as they go to the trash.
- A run that picks up where it stopped is told about a save that was refused, also when Scarlet had added a note to that answer.
- The keyboard shortcuts list no longer shows U for Undo, which the edit card doesn't have.
- You can draw on the picture for Scarlet: press M (or the pen by Full screen), circle, box or point at what you mean, and the marked frame goes with your next message.
- The "Starting a new edit" and "Move here" line above the message box is gone. The box's tag already says where a message goes.
- Stopping a request Scarlet is working on is one click again, on Stop at the right of the request, instead of inside a ⋯ menu.
- Pausing the video now writes its time at the start of the message box, so your next request is about the moment you stopped on.
- The time a request is about shows alone in the message box, without "At".
- Times in the message box are a little greyer instead of underlined.
- The New project window is shorter: just the name and the files, with a note only when audio would leave your computer.
- A new B-roll skill writes down what should be on screen at each spot first, so you choose what gets found or made before Scarlet spends time on it.
- Transcripts now keep the words you stumbled over and said again, like "the Coco, the Coca-Cola logo", so Scarlet can cut the false start instead of mistaking it for a pause.
- Scarlet now looks closely at your camera inset each time it crops it, so it can see when your head is cut off or you look too small.
- A first pass that finished its work no longer says "Couldn’t finish" when only its closing check for repeats failed to run; it says the check didn’t run, with Retry to run it again.
- A request that failed after saving some of its work now offers Resume, to pick up where it left off.
- Scarlet no longer leaves a stumbled restart playing because the transcript hid it: before tightening a pause, it now hears any words the transcript dropped there and decides on them.
- Backspace in an empty message box now takes off its time tag, also when an edit is open, and ⌘Z puts it back.
- Punch-ins on a talking head are milder across a cut inside a sentence, and no longer pull back out before the sentence ends.
- New project now lets you add videos one pick at a time, and each one has its own × to take it off the list.
- The model's Speed choice that uses the provider's own speed now says Standard instead of Auto.
- A Codex edit that stopped when Scarlet closed, or that asked you something, now carries on where it was instead of starting over.
- Requests about a long video, such as a few more frames on one cut, use far fewer tokens, and a pass no longer looks at the same screen frame again and again.
- A cut after the end of a sentence now comes right after the last word, before the breath that follows it, so the video no longer holds while you look away.
- Scarlet now notices when a screen recording switches windows or pages partway through a stretch it shows, so an insert no longer flashes another picture for a moment.
- When Scarlet cuts from a screen demo to your camera, it now knows how long the screen keeps showing that demo and what you say over it, so it can keep the screen up while you're still talking about what's on it.
- Keep in a pass's See all now goes on to the next moment as a whole, even when part of it was kept before, instead of opening one of its edits on its own.
- Scarlet now zooms in on any text shown or read on screen, including screenshots and pages over the camera, so it's readable, without zooming in line by line.
- A request's estimated cost now shows for new models as soon as their prices are published, and counts the higher price of Fast and Ultrafast speeds; when Scarlet has no price yet, the hover names the model.

## November 17, 2026

- Scarlet now sees where you read from the screen and where the screen is changing, so it frames screen demos on what you're actually doing.
- In a dialogue pass's See all, edits on the same moment are one row you watch and keep once, with its edits a press away, and a moment you play through with the list open is kept for you.
- See all now sits on its own line under the summary, where For you and See all sit when something needs you.
- Scarlet ends a request with a plain one-line summary of what it did, and anything it wants you to check is in For you instead of its reply.
- Hovering v2, Approved or whatever a cut’s or an edit’s row ends on says how long its revisions took and, when tokens are shown, how many tokens they used.
- Approving the last call on a dialogue pass finishes it: Scarlet no longer starts checking and editing again afterwards.
- Every edit in a request's list now ends with a word for what it did, and a camera punch-in next to a demo reads Zoom instead of nothing.

- There’s more space between the edit summary and the For you and See all tabs.
- Edit numbers on the timeline are numbered dots and pills again; the zoom percentage and − / + stay on the ruler.
- A pause Scarlet can’t shorten, such as one filled by a breath before your next line, no longer stops the other cuts saved with it.
- The built-in dialogue pass brings your voice in right after each cut, as Scarlet’s own pace does, instead of a tenth of a second later.
- Click Refresh models in the model picker to check for newly available models while you work.
- Edit numbers sit above the footage, and clicking the zoom percentage on the ruler fits the whole timeline.
- A cut Scarlet brings you because only your ear can settle its join stays in your review: a later cut of the same pass can no longer take its place.
- Click the speed beside Full screen to open the player’s − and + controls.
- Cuts Scarlet places by time now leave only the pause your skill asks for after your last word, instead of whatever quiet was there.
- A screen demo that ends or starts a frame or two off the camera's cut now changes on that cut, so your camera no longer flashes full frame between them.
- Speech transcription settings show your preferred model, when Scarlet uses bundled Whisper, and how to set up CrisperWhisper.
- When a restart begins on the word you had just said, the cut Scarlet brings you starts where that word begins: it used to start a frame or two later, so you could hear yourself start the word before the cut.

## November 16, 2026

- When Scarlet removes a restart, it no longer takes a word or two of the sentence you kept along with it, as in “this is absolutely … detail” where “beautiful” went with the stumble after it.
- A dialogue pass no longer trims a pause that has words in it the transcript missed, such as the “five point five” in “Opus 5.5” or a line you said twice. Scarlet reads what was said there and decides on the words.
- Numbers are timed where you say them, so the pause before one no longer looks empty.
- A cut that Scarlet later put back no longer stays in an edit's list or on the timeline.
- An edit’s token breakdown shows Est Cost using the model’s published API prices.
- Click − or + in the player or press those keys to change playback speed in 0.25× steps. Use [ and ] to zoom the timeline.
- Before a dialogue pass finishes, Scarlet rereads the cuts it made outside its dialogue cut tool that took words out of a sentence, and fixes a stray word or a sentence left without its start or its end.
- A photo or a title card that doesn’t move is ready in seconds, where Scarlet used to draw every frame of it.
- Scarlet zooms a screen recording to fill the video around what you’re showing, eases from one thing to the next across your cuts, and keeps your camera off the lines you read, moving it to another corner when it has to. A zoom no longer leaves empty bars at the sides.
- An edit's card no longer has an Undo edit button. To put an edit back, open it and ask in the message box.
- When Scarlet wants you to check part of an edit, its card has an amber Check tag that plays just that part, the timeline marks that part in amber, and an edit that changed nothing there no longer says Added.
- Scarlet checks that your camera, screen and mic recordings stay in sync through its edit, and tells you when one doesn't.
- Scarlet hears when you keep an edit it flagged, so a request still working doesn't ask you about it again.
- Scarlet stays connected when you pause media processing while it’s caching a video.
- The message box shows an edit’s time on its own and widens its tag to show the × on hover. Open +1 to see and clear an additional marked range.
- An edit you kept stays kept when Scarlet, still working, lists it again in other words, instead of asking you about it a second time.
- Pause above the message box pauses all editing in the project and Continue picks the paused work up first, where it left off. A paused request says Paused in the chat, questions can still be answered, and Stop this edit in a request’s menu ends just that one.
- About puts the installed version and update check at the top, shows the latest release notes, and folds earlier changes and usage report details into sections you can open.
- Pause and resume background caching and transcription from the Projects menu, the Media panel, or by hovering over Media.
- Make shorts works on recordings in a library you moved or restored from a backup, instead of asking you to reimport them.
- When Scarlet opens, a recording that was ready to transcribe starts at once, without waiting for another import to finish preparing.
- The message box shows the time of the cut or marked range beside your draft. Click the time to see and clear the targets.
- When Scarlet flags a spot inside a long edit, opening it takes you to the passage it wants you to review.
- A spot Scarlet marked for footage it doesn't have opens as a to-do: its card leads with what to add, has Done instead of Keep and nothing to compare or undo, and the timeline no longer shows it as a cut.
- What a request made counts the spots Scarlet marked for you on their own.
- A to-do Scarlet marked keeps saying what to add after you ask for a revision, and still waits for you to mark it done. An edit that changed the video and also left a marker keeps its Undo edit and Before/After.
- When you click the message box for an open edit, the cut icon shimmers in place of the popup.
- Numbered markers appear on the timeline as Scarlet applies edits during a dialogue pass.
- The token count in an edit’s heading updates as Codex works.

## November 15, 2026

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
