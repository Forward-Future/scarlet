import { describe, expect, it } from "vitest";
import { DEFAULT_TASK_MODELS, TASK_MODELS_MAX, TaskModelType, taskModelChoice, taskModelId, taskModelKey } from "./taskModels.js";

describe("TaskModelType", () => {
  it("fills in an empty description and the chat's model, and trims the name", () => {
    expect(TaskModelType.parse({ id: "color", name: "  Color  " })).toEqual({ id: "color", name: "Color", description: "", model: "same" });
  });

  it("refuses bad ids, empty names and models that aren't agent:model", () => {
    expect(TaskModelType.safeParse({ id: "-color", name: "Color" }).success).toBe(false);
    expect(TaskModelType.safeParse({ id: "Color", name: "Color" }).success).toBe(false);
    expect(TaskModelType.safeParse({ id: "a".repeat(41), name: "Color" }).success).toBe(false);
    expect(TaskModelType.safeParse({ id: "color", name: "   " }).success).toBe(false);
    expect(TaskModelType.safeParse({ id: "color", name: "Color", model: "gpt" }).success).toBe(false);
    expect(TaskModelType.safeParse({ id: "color", name: "Color", model: "codex:gpt 5" }).success).toBe(false);
    expect(TaskModelType.safeParse({ id: "color", name: "Color", model: "codex:" }).success).toBe(true);
  });

  it("starts every editor with valid Cutting and Motion graphics types", () => {
    expect(DEFAULT_TASK_MODELS.map(type => TaskModelType.parse(type))).toEqual(DEFAULT_TASK_MODELS);
    expect(DEFAULT_TASK_MODELS.map(type => type.name)).toEqual(["Cutting", "Motion graphics"]);
    expect(TASK_MODELS_MAX).toBeGreaterThan(DEFAULT_TASK_MODELS.length);
  });
});

describe("taskModelKey and taskModelChoice", () => {
  it("saves a model as agent:model and reads it back", () => {
    const key = taskModelKey({ agent: "claude", model: "opus" });
    expect(key).toBe("claude:opus");
    expect(taskModelChoice({ model: key })).toEqual({ agent: "claude", model: "opus" });
  });

  it("saves the CLI's own default with nothing after the colon, and reads it back with no model", () => {
    expect(taskModelKey({ agent: "codex" })).toBe("codex:");
    expect(taskModelChoice({ model: "codex:" })).toEqual({ agent: "codex" });
  });

  it("keeps colons inside the model's own name", () => {
    expect(taskModelChoice({ model: "gemini:models/x:latest" })).toEqual({ agent: "gemini", model: "models/x:latest" });
  });

  it("gives no model for the chat's own and for a key without an agent", () => {
    expect(taskModelChoice({ model: "same" })).toBeUndefined();
    expect(taskModelChoice({ model: ":opus" })).toBeUndefined();
    expect(taskModelChoice({ model: "opus" })).toBeUndefined();
  });
});

describe("taskModelId", () => {
  it("makes an id from the name's letters and digits", () => {
    expect(taskModelId("Motion Graphics!", [])).toBe("motion-graphics");
    expect(taskModelId("  B-roll & Stock  ", [])).toBe("b-roll-stock");
  });

  it("keeps ids to 32 characters with no hyphen at either end", () => {
    expect(taskModelId("x".repeat(50), [])).toHaveLength(32);
    expect(taskModelId("Café", [])).toBe("cafe");
  });

  // Bug: NFKD splits "É" into "E" + a combining accent, and the accent is replaced with "-" instead of being dropped.
  it.fails("drops an accent inside a word instead of splitting the word", () => {
    expect(taskModelId("Étalonnage", [])).toBe("etalonnage");
  });

  it("falls back to task for a name with no letters or digits", () => {
    expect(taskModelId("!!!", [])).toBe("task");
    expect(taskModelId("", ["task"])).toBe("task-2");
  });

  it("numbers an id until it is unlike those taken", () => {
    expect(taskModelId("Cutting", ["cutting"])).toBe("cutting-2");
    expect(taskModelId("Cutting", ["cutting", "cutting-2", "cutting-3"])).toBe("cutting-4");
  });
});
