import { describe, expect, test } from "bun:test";
import { pendingProfileAsks, pendingProfileInjections, seedFormValues } from "../../ui/src/composer-move-forms";
import type { MoveInput, MoveListItem, ProfileMoveBinding } from "../../sdk/index";

function move(name: string, inputs: MoveInput[] = [], extra: Partial<MoveListItem> = {}): MoveListItem {
  return {
    name,
    label: name,
    description: "",
    inputs,
    ...extra,
  } as MoveListItem;
}

const textInput: MoveInput = { name: "topic", type: "text" };
const toggleInput: MoveInput = { name: "verbose", type: "toggle" };

describe("seedFormValues", () => {
  test("a binding's supplied value wins over the input's default", () => {
    const values = seedFormValues(
      [{ name: "topic", type: "text", default: "fallback" }],
      { topic: "from binding" },
    );
    expect(values.topic).toBe("from binding");
  });

  test("an absent binding value falls through to the input default", () => {
    const values = seedFormValues(
      [{ name: "topic", type: "text", default: "fallback" }],
      { other: "ignored" },
    );
    expect(values.topic).toBe("fallback");
  });

  test("a field with neither a binding value nor a default is left unset", () => {
    expect(seedFormValues([textInput], undefined)).toEqual({});
  });

  // A binding is hand-written JSON, so `true` is the natural way to write a
  // toggle — but the form layer speaks "yes"/"". Both must mean the same thing
  // or a profile-seeded toggle renders unchecked and silently flips on submit.
  test("boolean and string toggle values both seed as checked", () => {
    expect(seedFormValues([toggleInput], { verbose: true }).verbose).toBe("yes");
    expect(seedFormValues([toggleInput], { verbose: "yes" }).verbose).toBe("yes");
  });

  test("a false toggle seeds as unchecked, not the string \"false\"", () => {
    expect(seedFormValues([toggleInput], { verbose: false }).verbose).toBe("");
  });

  test("non-string scalars are stringified for the form", () => {
    const values = seedFormValues([{ name: "count", type: "number" }], { count: 7 });
    expect(values.count).toBe("7");
  });

  test("no inputs yields no values rather than throwing", () => {
    expect(seedFormValues(undefined, { a: 1 })).toEqual({});
  });
});

describe("pendingProfileAsks", () => {
  const available = [
    move("briefing", [textInput]),
    move("silent", []),
    move("regimen", [textInput, toggleInput]),
  ];

  test("only bindings marked ask raise a form", () => {
    const bindings: ProfileMoveBinding[] = [
      { name: "briefing", ask: true },
      { name: "regimen" },
    ];
    expect(pendingProfileAsks(bindings, available).map((a) => a.move.name)).toEqual(["briefing"]);
  });

  // The harness skips an input-less `ask` binding at session start, so offering
  // a form with no fields would be a dead end the user cannot act on.
  test("an ask binding on a move with no inputs is dropped", () => {
    expect(pendingProfileAsks([{ name: "silent", ask: true }], available)).toEqual([]);
  });

  test("a binding naming a move this project does not have is dropped", () => {
    expect(pendingProfileAsks([{ name: "absent", ask: true }], available)).toEqual([]);
  });

  test("declared inputs ride along as the form's seed values", () => {
    const asks = pendingProfileAsks(
      [{ name: "regimen", ask: true, inputs: { topic: "architecture" } }],
      available,
    );
    expect(asks).toHaveLength(1);
    expect(asks[0]!.initialValues).toEqual({ topic: "architecture" });
  });

  test("declaration order is preserved", () => {
    const asks = pendingProfileAsks(
      [{ name: "regimen", ask: true }, { name: "briefing", ask: true }],
      available,
    );
    expect(asks.map((a) => a.move.name)).toEqual(["regimen", "briefing"]);
  });

  test("no bindings yields no asks", () => {
    expect(pendingProfileAsks(undefined, available)).toEqual([]);
  });
});

describe("pendingProfileInjections", () => {
  const available = [
    move("briefing", [textInput]),
    move("house-style", []),
    move("watcher", [], { persistent: true }),
  ];

  // The whole point: a profile move that silently prepends tokens to the first
  // message must be visible before that message is sent, even though — in fact
  // especially because — it asks the user for nothing.
  test("an input-less inline binding is shown, since it injects without asking", () => {
    const shown = pendingProfileInjections([{ name: "house-style" }], available);
    expect(shown.map((m) => m.name)).toEqual(["house-style"]);
  });

  test("an inline binding with inputs is shown too", () => {
    const shown = pendingProfileInjections([{ name: "briefing" }], available);
    expect(shown.map((m) => m.name)).toEqual(["briefing"]);
  });

  // An ask binding raises a form instead; showing both would double-count it.
  test("an ask binding is not also listed as an injection", () => {
    expect(pendingProfileInjections([{ name: "briefing", ask: true }], available)).toEqual([]);
  });

  // Persistent moves activate post-spawn and already have ambient chips with a
  // working deactivate, so listing them here would be a second, worse control.
  test("a persistent binding is left to the ambient chips", () => {
    expect(pendingProfileInjections([{ name: "watcher" }], available)).toEqual([]);
  });

  test("a binding naming a move this project does not have is dropped", () => {
    expect(pendingProfileInjections([{ name: "ghost" }], available)).toEqual([]);
  });

  test("declaration order is preserved", () => {
    const shown = pendingProfileInjections(
      [{ name: "house-style" }, { name: "briefing" }],
      available,
    );
    expect(shown.map((m) => m.name)).toEqual(["house-style", "briefing"]);
  });

  test("no bindings yields nothing", () => {
    expect(pendingProfileInjections(undefined, available)).toEqual([]);
  });
});
