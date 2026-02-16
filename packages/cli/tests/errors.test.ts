import { describe, it, expect } from "bun:test";
import { Lo1Error } from "../src/errors";

class ConfigError extends Lo1Error {
  constructor(message: string) {
    super(message, "ConfigError");
    this.name = "ConfigError";
  }
}

describe("Lo1Error", () => {
  it("toJSON returns { error, message } when no details", () => {
    const err = new Lo1Error("something broke", "SomeCode");

    expect(err.toJSON()).toEqual({
      error: "SomeCode",
      message: "something broke",
    });
  });

  it("toJSON spreads details into the result", () => {
    const err = new Lo1Error("bad input", "ValidationError", {
      field: "name",
      expected: "string",
    });

    expect(err.toJSON()).toEqual({
      error: "ValidationError",
      message: "bad input",
      field: "name",
      expected: "string",
    });
  });

  it("is an instance of Error", () => {
    const err = new Lo1Error("msg", "Code");

    expect(err).toBeInstanceOf(Error);
  });

  it('has name set to "Lo1Error"', () => {
    const err = new Lo1Error("msg", "Code");

    expect(err.name).toBe("Lo1Error");
  });

  it("exposes the code property", () => {
    const err = new Lo1Error("msg", "MyCode");

    expect(err.code).toBe("MyCode");
  });

  describe("subclass", () => {
    it("is an instance of both Lo1Error and the subclass", () => {
      const err = new ConfigError("invalid config");

      expect(err).toBeInstanceOf(Lo1Error);
      expect(err).toBeInstanceOf(ConfigError);
      expect(err).toBeInstanceOf(Error);
    });

    it("preserves the subclass name", () => {
      const err = new ConfigError("invalid config");

      expect(err.name).toBe("ConfigError");
    });

    it("serializes correctly via toJSON", () => {
      const err = new ConfigError("missing field");

      expect(err.toJSON()).toEqual({
        error: "ConfigError",
        message: "missing field",
      });
    });
  });
});
