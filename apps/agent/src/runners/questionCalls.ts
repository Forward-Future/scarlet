// How a runner holds and settles a task_question call, shared by the Codex and Gemini parsers.

/** A question call as a runner's parse state holds it: its words, the call that asked them, and whether the engine has them. */
export interface QuestionCallState {
  question?: string;
  /** The call that asked `question`. */
  questionCall?: string;
  questionPosted: boolean;
  shouldStop: boolean;
}

/**
 * Hold a question call's words from the start, should the CLI stop before its result. The question is the call that
 * asked it: a later call can't take its place.
 */
export function holdQuestion(st: QuestionCallState, call: string | undefined, text: string | undefined): void {
  if (text !== undefined && (st.question === undefined || st.questionCall === call)) {
    st.question = text;
    st.questionCall = call;
  }
}

/**
 * Settle a finished question call. Its words when it asked the held question and Scarlet took it: the engine has the
 * question, and the runner stops. One Scarlet refused was never asked: the model hears why and carries on, so the run
 * does too, and a refused later call doesn't clear the question still held.
 */
export function settleQuestion(st: QuestionCallState, call: string | undefined, refused: boolean): string | undefined {
  const asked = st.question !== undefined && st.questionCall === call;
  if (asked && !refused) {
    st.questionPosted = true;
    st.shouldStop = true;
    return st.question;
  }
  if (asked) st.question = st.questionCall = undefined;
  return undefined;
}
