import { Command } from "commander";
import { loadWorkspaceConfig, ConfigError } from "../../config/loader";
import { collectDomains } from "../../proxy/domains";
import { generateHostsBlock, applyHosts, removeHosts, HostsError } from "../../hosts/index";

export const hostsCommand = new Command("hosts")
  .description("Manage /etc/hosts entries for local domains")
  .option("--apply", "Write managed block to /etc/hosts (requires sudo)")
  .option("--remove", "Remove managed block from /etc/hosts (requires sudo)")
  .option("--config <path>", "Path to lo1.yaml config file", "lo1.yaml")
  .action(async (options) => {
    try {
      if (options.remove) {
        await removeHosts();
        console.log("Removed lo1 hosts entries.");
        return;
      }

      const config = await loadWorkspaceConfig(options.config);
      const domains = collectDomains(config);

      if (domains.length === 0) {
        console.log("No domains to configure.");
        return;
      }

      const block = generateHostsBlock(domains);

      if (options.apply) {
        await applyHosts(block);
        console.log(`Applied ${domains.length} domain(s) to hosts file.`);
      } else {
        console.log(block);
      }
    } catch (err) {
      if (err instanceof ConfigError || err instanceof HostsError) {
        console.error(err.message);
        process.exit(1);
      }
      throw err;
    }
  });
