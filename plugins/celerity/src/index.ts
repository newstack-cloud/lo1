import type { PluginFactory } from "@lo1/sdk";

const createPlugin: PluginFactory = (context) => {
  context.logger.info("Celerity plugin loaded");

  return {
    name: "celerity",

    // TODO: L8 — implement Celerity plugin lifecycle methods
    // async contributeCompose(input) { },
    // async provisionInfra(input) { },
    // async seedData(input) { },
    // async configureContainer(input) { },
    // async *watchForChanges(input) { },
  };
};

export default createPlugin;
