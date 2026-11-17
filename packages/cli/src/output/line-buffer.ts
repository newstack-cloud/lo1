import type { EventEmitter } from "node:events";

/** Feeds chunks in; `flush` emits whatever partial line is left at the end. */
export type LineBuffer = ((chunk: string) => void) & { flush: () => void };

/**
 * Creates a line-buffering function that accumulates chunks and emits
 * complete lines (split on newline). Partial trailing content is held
 * until the next chunk completes the line, or until `flush`. Blank lines
 * are dropped.
 */
export function createLineBuffer(onLine: (line: string) => void): LineBuffer {
  let buffer = "";
  const emit = (line: string) => {
    const text = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (text.trim()) onLine(text);
  };

  const push = (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) emit(line);
  };

  return Object.assign(push, {
    flush: () => {
      const rest = buffer;
      buffer = "";
      emit(rest);
    },
  });
}

/**
 * Calls `onLine` with each line a stream writes, so output from a child
 * process arrives whole however the OS chunks it. A last line without a
 * newline is emitted when the stream ends.
 */
export function followLines(stream: EventEmitter, onLine: (line: string) => void): void {
  const buffer = createLineBuffer(onLine);
  stream.on("data", (chunk: Buffer | string) => buffer(chunk.toString()));
  stream.on("end", () => buffer.flush());
}
