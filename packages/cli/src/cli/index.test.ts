import { describe, expect, test } from "bun:test";
import { program } from "./index";

describe("cli", () => {
  test("program has expected commands", () => {
    const commandNames = program.commands.map((cmd) => cmd.name());
    expect(commandNames).toContain("init");
    expect(commandNames).toContain("up");
    expect(commandNames).toContain("down");
    expect(commandNames).toContain("status");
  });
});
