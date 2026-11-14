# Scarlet editing workflows

Every project uses the same library. A skill command pins its guide to the task. The default dialogue workflow is `/dialogue-pass`. Scarlet records a built-in dialogue shortcut as an editing operation. The agent can consult any enabled guide and choose tools based on the request and footage.

| Stage | Workflow | Use it when |
|---|---|---|
| Story and pacing | [Dialogue pass](dialogue-pass/SKILL.md) | Remove abandoned starts, redundant takes and distracting pauses while preserving the speaker’s meaning and pace. A selected passage limits the cut. |
| Picture and graphics | [Frame the screen on what I'm doing](frame-screen/SKILL.md) | Frame tight on the pane or passage being used or read, with smooth zooms in and out as the subject changes. |
| Picture and graphics | [Add captions](add-captions/SKILL.md) | Caption retained speech in short, readable lines. |

The built-in `/tighten-pauses-here` command limits the request to local pauses. The dialogue guide sets the defaults for what to cut, what to review and how much space to leave around speech. It uses straight cuts. Editors can request audio smoothing separately. Project context, permissions and scope belong to Scarlet. [Skill and tool ownership](../docs/skills-and-tools.md)

Scarlet includes workflows adapted from Alex’s editing skills. [Upstream snapshot](https://github.com/Forward-Future/alexs-davinci-editing-skills/tree/984c321a45debcd7c207953dc3169d6992d14b15/skills) · [MIT license](../apps/desktop/src-tauri/licenses/alex-editing-skills.txt)
