import { describe, it, expect } from "bun:test";
import { platform } from "node:os";
import {
  buildElevatedCopyCommand,
  generateHostsBlock,
  replaceHostsBlock,
  removeHostsBlock,
  getHostsFilePath,
} from "../../src/hosts/index";

describe("getHostsFilePath", () => {
  it("should return a platform-appropriate path", () => {
    const hostsPath = getHostsFilePath();

    if (platform() === "win32") {
      expect(hostsPath).toContain("drivers");
      expect(hostsPath).toContain("hosts");
    } else {
      expect(hostsPath).toBe("/etc/hosts");
    }
  });
});

describe("generateHostsBlock", () => {
  it("should produce block with IPv4 and IPv6 entries and markers", () => {
    const domains = ["api.my-app.local", "web.my-app.local"];

    const block = generateHostsBlock(domains);

    expect(block).toContain("# lo1-start");
    expect(block).toContain("# lo1-end");
    expect(block).toContain("127.0.0.1 api.my-app.local web.my-app.local");
    expect(block).toContain("::1 api.my-app.local web.my-app.local");
  });

  it("should return empty string for empty domains", () => {
    const block = generateHostsBlock([]);

    expect(block).toBe("");
  });
});

describe("replaceHostsBlock", () => {
  it("should append block when no markers present", () => {
    const current = "127.0.0.1 localhost\n";
    const block = "# lo1-start\n127.0.0.1 api.local\n# lo1-end\n";

    const result = replaceHostsBlock(current, block);

    expect(result).toContain("127.0.0.1 localhost");
    expect(result).toContain("# lo1-start");
    expect(result).toContain("127.0.0.1 api.local");
    expect(result).toContain("# lo1-end");
  });

  it("should replace existing marker block", () => {
    const current =
      "127.0.0.1 localhost\n# lo1-start\n127.0.0.1 old.local\n# lo1-end\n::1 localhost\n";
    const block = "# lo1-start\n127.0.0.1 new.local\n# lo1-end\n";

    const result = replaceHostsBlock(current, block);

    expect(result).toContain("127.0.0.1 localhost");
    expect(result).toContain("127.0.0.1 new.local");
    expect(result).not.toContain("old.local");
    expect(result).toContain("::1 localhost");
  });

  it("should handle content that does not end with newline", () => {
    const current = "127.0.0.1 localhost";
    const block = "# lo1-start\n127.0.0.1 api.local\n# lo1-end\n";

    const result = replaceHostsBlock(current, block);

    expect(result).toContain("127.0.0.1 localhost\n# lo1-start");
  });
});

describe("removeHostsBlock", () => {
  it("should strip marker block and preserve other content", () => {
    const current =
      "127.0.0.1 localhost\n# lo1-start\n127.0.0.1 api.local\n# lo1-end\n::1 localhost\n";

    const result = removeHostsBlock(current);

    expect(result).toContain("127.0.0.1 localhost");
    expect(result).toContain("::1 localhost");
    expect(result).not.toContain("# lo1-start");
    expect(result).not.toContain("api.local");
    expect(result).not.toContain("# lo1-end");
  });

  it("should return content unchanged when no markers present", () => {
    const current = "127.0.0.1 localhost\n::1 localhost\n";

    const result = removeHostsBlock(current);

    expect(result).toBe(current);
  });
});

describe("buildElevatedCopyCommand", () => {
  const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

  function innerCommand(command: string): string {
    const encoded = command.match(/'-EncodedCommand','([^']+)'/)![1];
    return Buffer.from(encoded, "base64").toString("utf16le");
  }

  it("should start an elevated PowerShell and exit with its exit code", () => {
    const command = buildElevatedCopyCommand("C:\\Temp\\hosts", "C:\\etc\\hosts", powershell);

    expect(command).toStartWith(`$p = Start-Process -FilePath '${powershell}' -Verb RunAs -Wait`);
    expect(command).toEndWith("; exit $p.ExitCode");
  });

  it("should copy the staged file over the hosts file", () => {
    const command = buildElevatedCopyCommand("C:\\Temp\\hosts", "C:\\etc\\hosts", powershell);

    expect(innerCommand(command)).toBe(
      "Copy-Item -LiteralPath 'C:\\Temp\\hosts' -Destination 'C:\\etc\\hosts' -Force -ErrorAction Stop",
    );
  });

  it("should escape apostrophes in paths", () => {
    const command = buildElevatedCopyCommand("C:\\Users\\o'neil\\hosts", "C:\\etc\\hosts", powershell);

    expect(innerCommand(command)).toContain("'C:\\Users\\o''neil\\hosts'");
  });
});
