/**
 * Creates a line-buffering function that accumulates chunks and emits
 * complete lines (split on newline). Partial trailing content is held
 * until the next chunk completes the line.
 */
export function createLineBuffer(onLine: (line: string) => void): (chunk: string) => void {
  let buffer = "";

  return (chunk: string) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) onLine(line);
    }
  };
}
