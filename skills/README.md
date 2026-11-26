# Scarlet editing workflows

Every project uses the same library. A skill command pins its guide to the task. The default dialogue workflow is `/dialogue-pass`. Scarlet records a built-in dialogue shortcut as an editing operation. The agent can consult any enabled guide and choose tools based on the request and footage.

| Stage | Workflow | Use it when |
|---|---|---|
| Story and pacing | [Dialogue pass](dialogue-pass/SKILL.md) | Remove abandoned starts, redundant takes and distracting pauses while preserving the speaker’s meaning and pace. A selected passage limits the cut. |
| Story and pacing | [Fit a target length](fit-length/SKILL.md) | Bring the edit to a running time you name by taking out the passages it needs least, and offer the rest when hitting the number would cost something. |
| Story and pacing | [Speed through waits](speed-through-waits/SKILL.md) | Play installs, builds, renders and loading fast instead of cutting them, with every track in sync and speech at normal speed. |
| Story and pacing | [Split edits](split-edits/SKILL.md) | J and L cuts: let the next voice lead into its shot, or a line carry on over the listener, in interviews, conversations and reactions. |
| Story and pacing | [Multi-camera editing](multi-cam/SKILL.md) | Sync multiple cameras and audio tracks, match speakers to angles, and switch shots with natural pacing for podcasts and interviews. |
| Sound | [Music under speech](music-under-speech/SKILL.md) | Dip music under speech so every word is clear, and let it swell back up in the pauses and where nobody speaks. |
| Picture and graphics | [Frame the screen on what I'm doing](frame-screen/SKILL.md) | Frame tight on the pane or passage being used or read, with smooth zooms in and out as the subject changes. |
| Picture and graphics | [Punch-ins on a talking head](punch-in/SKILL.md) | Cut between the wide framing and a tighter one across jump cuts and on lines that deserve weight, with the face placed from where it actually is. |
| Picture and graphics | [Add captions](add-captions/SKILL.md) | Caption retained speech in short, readable lines. |
| Picture and graphics | [Motion graphics](motion-graphics/SKILL.md) | Lower thirds, titles and callouts that read well on the footage, in the project's style guide or the look the editor has approved. |
| Picture and graphics | [B-roll and graphics](b-roll/SKILL.md) | Describe what should be on screen at each spot first, as To dos, then find footage or make a graphic only for the ones you ask for. |
| Examples | [Matt’s talking-head edit](matt-talking-head/SKILL.md) | Example talking-head style built on the dialogue pass, screen framing and punch-ins: tight joins, spoken notes to the editor acted on, and two-frame audio crossfades. Installed switched off: an example style to read or copy. |

The built-in `/tighten-pauses-here` command limits the request to local pauses. The dialogue guide sets the defaults for what to cut, what to review and how much space to leave around speech. It uses straight cuts. Editors can request audio smoothing separately. Project context, permissions and scope belong to Scarlet. [Skill and tool ownership](../docs/skills-and-tools.md)

Scarlet includes workflows adapted from Alex’s editing skills. [Upstream snapshot](https://github.com/Forward-Future/alexs-davinci-editing-skills/tree/984c321a45debcd7c207953dc3169d6992d14b15/skills) · [MIT license](../apps/desktop/src-tauri/licenses/alex-editing-skills.txt)

## Building on other skills

Scarlet's code knows no skill by its name. A skill says what it is in its own header: `category:` files it, and `runs:` makes it the guide of one of Scarlet's built-in commands (`runs: dialogue-pass, tighten-pauses-here`), whatever the skill is called. So any skill here can be renamed, rewritten or deleted, or replaced by one an editor writes from scratch, and Scarlet keeps working. Skills Scarlet no longer ships are listed in [retired.json](retired.json), so older libraries upgrade cleanly. A skill names tools, never a model: which model does a kind of work is the editor's choice in Settings → Models.

An editor's own style can add to shipped guides instead of copying them. Call a guide by its command in the skill's text, at the place it applies, and write what differs beside the call: `/frame-screen, with these changes: my camera inset is 1.5:1 with rounded corners.` Scarlet reads every guide a skill calls ahead of the skill itself, in the order it calls them, and the skill wins where they differ. A skill that calls `/dialogue-pass` runs a pass by its own command. A guide can also be named in the header (`extends: dialogue-pass`, several with commas between them). The guides' later improvements reach the style. Keep what suits every editor in the shipped guide and what is one editor's own in theirs. [Matt's talking-head edit](matt-talking-head/SKILL.md) works this way.
