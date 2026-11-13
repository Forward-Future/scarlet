# Scarlet editing workflows

Every project uses the same library. A skill command pins its guide to the task. The default dialogue workflow is `/dialogue-pass`. Scarlet records a built-in dialogue shortcut as an editing operation. The agent can consult any enabled guide and choose tools based on the request and footage.

| Stage | Workflow | Use it when |
|---|---|---|
| Story and pacing | [Dialogue pass](dialogue-pass/SKILL.md) | Remove abandoned starts, redundant takes and distracting pauses while preserving the speaker’s meaning and pace. A selected passage limits the cut. |
| Sound | [Clean dialogue](clean-dialogue/SKILL.md) | Correct sustained noise, tone or level on a particular microphone. |
| Sound | [Smooth audio cuts](smooth-audio-cuts/SKILL.md) | Repair a click or room-tone change at a specific splice. |
| Picture and graphics | [Edit an interview](edit-interview/SKILL.md) | Choose camera coverage or a speaker layout over an existing conversation. |
| Picture and graphics | [Frame the screen on the subject](frame-screen/SKILL.md) | Frame the relevant window, subject or passage and keep enough surrounding context to follow it. |
| Picture and graphics | [Visual pass](visual-pass/SKILL.md) | Add supplied cutaways, titles or graphics while keeping dialogue timing. |
| Picture and graphics | [Add captions](add-captions/SKILL.md) | Caption retained speech in short, readable lines. |

The built-in `/tighten-pauses-here` command limits the request to local pauses. The dialogue guide sets the editorial defaults for what to cut, what to review, how much space to leave around speech and how to blend the sound at a join. Project context, permissions and scope belong to Scarlet. [Skill and tool ownership](../docs/skills-and-tools.md)

Scarlet includes workflows adapted from Alex’s editing skills. [Upstream snapshot](https://github.com/Forward-Future/alexs-davinci-editing-skills/tree/984c321a45debcd7c207953dc3169d6992d14b15/skills) · [MIT license](../apps/desktop/src-tauri/licenses/alex-editing-skills.txt)
