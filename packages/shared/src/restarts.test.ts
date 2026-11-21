import { describe, expect, it } from "vitest";
import { findRestarts } from "./restarts.js";

const said = (text: string, gaps: Record<number, number> = {}, options?: Parameters<typeof findRestarts>[3]) => {
  const tokens = text.toLowerCase().replace(/[^a-z0-9' ]/g, "").split(/\s+/);
  let t = 0;
  const starts: number[] = [], ends: number[] = [];
  tokens.forEach((_, i) => { t += gaps[i] ?? 0; starts.push(t); t += .3; ends.push(t); });
  return { tokens, found: findRestarts(tokens, starts, ends, options) };
};
const phrases = (r: ReturnType<typeof said>) => r.found.map(f => [r.tokens.slice(f.at, f.at + f.length).join(" "), r.tokens.slice(f.at + f.length, f.next).join(" ")]);

describe("restarts", () => {
  it("finds a phrase that comes back after an abandoned continuation, and an immediate retake", () => {
    expect(phrases(said("the water is gorgeous there's this like white I don't know what that is there's this like white stuff around the rocks")))
      .toEqual([["there's this like white", "i don't know what that is"]]);
    expect(phrases(said("very fast and in fact you can load it locally and in fact you can load it locally if you have a gpu")))
      .toEqual([["and in fact you can load it locally", ""]]);
    // One word left out of the second saying: the whole first attempt comes back.
    expect(said("a model that just outputs something so that outputs something so wild").found).toEqual([{ at: 2, length: 5, next: 7, again: 4 }]);
  });

  it("finds a first attempt said again with one word added or dropped, on three words that match", () => {
    expect(said("so we can see exactly how mechanical watch how a mechanical watch works").found).toEqual([{ at: 5, length: 3, next: 8, again: 4 }]);
    expect(said("we see how a mechanical watch how mechanical watch works").found).toEqual([{ at: 2, length: 4, next: 6, again: 3 }]);
    // Two words that match are ordinary speech, and so is a phrase that goes on to say something else.
    expect(said("the red the blue car").found).toEqual([]);
    expect(said("we went to the shop and we to the beach").found).toEqual([]);
  });

  it("finds a first try that stops on a word the next try says longer", () => {
    // Neon review 2, 3:44: "Okay. So perfect. So perfectly realistic." was left in.
    const cutOff = { cutOffWords: true };
    expect(phrases(said("we have it right here okay so perfect so perfectly realistic everything looks really good", {}, cutOff)))
      .toEqual([["so perfect", ""]]);
    expect(phrases(said("and we want we wanted to see it", {}, cutOff))).toEqual([["we want", ""]]);
    // Only the word the first try stops on, and only a word the next one goes on from: a shorter word that comes back
    // longer later in the sentence is ordinary speech.
    expect(said("so perfect for me so perfectly fine", {}, cutOff).found).toEqual([]);
    expect(said("so perfectly so perfect", {}, cutOff).found).toEqual([]);
    expect(said("the car the car", {}, cutOff).found).toEqual([{ at: 0, length: 2, next: 2 }]);
    expect(said("a an apple a and", {}, cutOff).found).toEqual([]);
  });

  it("compares a contraction as the word it starts with", () => {
    expect(phrases(said("give me a detailed prompt and have and then I will basically and then I'll copy paste the prompt")))
      .toEqual([["and then i", "will basically"]]);
    expect(said("it's a really good model it is a really good model").found).toEqual([{ at: 0, length: 5, next: 5, again: 6 }]);
  });

  it("finds a restart inside the first attempt of a longer match", () => {
    expect(phrases(said("has it read a line of code sam altman hasn't read a sam altman hasn't read a line of code in a year")))
      .toEqual([["read a line of code", "sam altman hasn't read a sam altman hasn't"], ["sam altman hasn't read a", ""]]);
  });

  it("pairs a third saying with the second, and takes the longest phrase a word starts", () => {
    const r = said("so I asked it so I asked it so I asked it now estimate");
    expect(r.found).toEqual([{ at: 0, length: 4, next: 4 }, { at: 4, length: 4, next: 8 }]);
  });

  it("leaves ordinary speech alone: two shared words apart, one word doubled, a phrase said again much later", () => {
    expect(said("you can draw on it and you can have different colors").found).toEqual([]);
    expect(said("it is very very fast").found).toEqual([]);
    // Thirteen words between, and then thirty seconds between.
    expect(said("we have the test here one two three four five six seven eight nine ten eleven twelve thirteen we have the test again").found).toEqual([]);
    expect(said("here is the plate okay here is the plate", { 5: 30 }).found).toEqual([]);
  });

  it("takes two words only when at most one word comes between", () => {
    expect(phrases(said("and I do not want and I do not need it"))).toEqual([["and i do not", "want"]]);
    expect(phrases(said("blue orange uh blue orange then green"))).toEqual([["blue orange", "uh"]]);
    expect(said("blue orange and then blue orange").found).toEqual([]);
  });
});
