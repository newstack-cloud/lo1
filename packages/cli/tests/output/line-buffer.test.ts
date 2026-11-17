import { describe, it, expect } from "bun:test";
import { PassThrough } from "node:stream";
import { createLineBuffer, followLines } from "../../src/output/line-buffer";

describe("createLineBuffer", () => {
  it("splits chunks into lines, joining a line split across chunks", () => {
    const lines: string[] = [];
    const push = createLineBuffer((l) => lines.push(l));

    push("first\nsec");
    push("ond\n\nthird\r\n");

    expect(lines).toEqual(["first", "second", "third"]);
  });

  it("emits a trailing partial line on flush", () => {
    const lines: string[] = [];
    const push = createLineBuffer((l) => lines.push(l));

    push("done");
    push.flush();
    push.flush();

    expect(lines).toEqual(["done"]);
  });
});

describe("followLines", () => {
  it("gives each line of a stream its own call, flushing at the end", async () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    followLines(stream, (l) => lines.push(l));

    stream.write("\nadded 14 packages in 213ms\nmigrations ");
    stream.end("applied");
    await new Promise((r) => setImmediate(r));

    expect(lines).toEqual(["added 14 packages in 213ms", "migrations applied"]);
  });
});
