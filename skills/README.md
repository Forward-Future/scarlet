# Scarlet editing workflows

Every project uses the same library. A skill command pins its guide to the task. The default dialogue workflow is `/dialogue-pass`. Scarlet records a built-in dialogue shortcut as an editing operation. The agent can consult any enabled guide and choose tools based on the request and footage.

| Stage | Workflow | Use it when |
|---|---|---|
| Story and pacing | [Dialogue pass](dialogue-pass/SKILL.md) | Remove abandoned starts, redundant takes and distracting pauses while preserving the speaker’s meaning and pace. A selected passage limits the cut. |
| Story and pacing | [Matt’s talking-head edit](matt-talking-head/SKILL.md) | A dialogue pass in Matt Berman’s style, built on the dialogue pass: tight joins, his notes to the editor acted on, two-frame audio crossfades, camera punch-ins and framing for screen demos. |
| Story and pacing | [Fit a target length](fit-length/SKILL.md) | Bring the edit to a running time you name by taking out the passages it needs least, and offer the rest when hitting the number would cost something. |
| Story and pacing | [Cold open](cold-open/SKILL.md) | Suggest the strongest moment to open the video, for you to play and apply or send back for another. Nothing goes in front on its own. |
| Story and pacing | [Speed through waits](speed-through-waits/SKILL.md) | Play installs, builds, renders and loading fast instead of cutting them, with every track in sync and speech at normal speed. |
| Story and pacing | [Make shorts](make-shorts/SKILL.md) | Choose the strongest self-contained moments of a long video and cut each into a short of its own, framed for its shape and captioned. Make shorts in the ⋯ menu starts it, with a project for each short. |
| Picture and graphics | [Frame the screen on what I'm doing](frame-screen/SKILL.md) | Frame tight on the pane or passage being used or read, with smooth zooms in and out as the subject changes. |
| Picture and graphics | [Punch-ins on a talking head](punch-in/SKILL.md) | Cut between the wide framing and a tighter one across jump cuts and on lines that deserve weight, with the face placed from where it actually is. |
| Picture and graphics | [Add captions](add-captions/SKILL.md) | Caption retained speech in short, readable lines. |
| Picture and graphics | [Motion graphics](motion-graphics/SKILL.md) | Lower thirds, titles and callouts that read well on the footage, in the project's style guide or the look the editor has approved. |

The built-in `/tighten-pauses-here` command limits the request to local pauses. The dialogue guide sets the defaults for what to cut, what to review and how much space to leave around speech. It uses straight cuts. Editors can request audio smoothing separately. Project context, permissions and scope belong to Scarlet. [Skill and tool ownership](../docs/skills-and-tools.md)

Scarlet includes workflows adapted from Alex’s editing skills. [Upstream snapshot](https://github.com/Forward-Future/alexs-davinci-editing-skills/tree/984c321a45debcd7c207953dc3169d6992d14b15/skills) · [MIT license](../apps/desktop/src-tauri/licenses/alex-editing-skills.txt)

## Building on another skill

An editor's own style can add to a shipped guide instead of copying it: put `extends: dialogue-pass` in the skill's header and write only what differs. Its command then runs a dialogue pass, with the guide it builds on read first and the style after it, and the style wins where they differ. The guide's later improvements reach the style. [Matt's talking-head edit](matt-talking-head/SKILL.md) works this way.
