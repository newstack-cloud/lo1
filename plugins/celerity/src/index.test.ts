import { describe, expect, test } from "bun:test";
import createPlugin from "./index";
import { Plugin } from "@lo1/sdk";

describe("celerity plugin", () => {
  test("factory returns a plugin with name 'celerity'", () => {
    const plugin = createPlugin({
      workspaceDir: "/tmp/test",
      workspaceName: "test",
      logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    }) as Plugin;

    expect(plugin.name).toBe("celerity");
  });
});
