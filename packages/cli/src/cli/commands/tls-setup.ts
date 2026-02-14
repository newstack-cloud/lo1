import { Command } from "commander";
import { trustCaddyCa, TlsError } from "../../tls/setup";

export const tlsSetupCommand = new Command("tls-setup")
  .description("Trust Caddy's local CA so browsers accept TLS certificates without warnings")
  .action(async () => {
    try {
      console.log("Installing Caddy root CA into system trust store...");
      await trustCaddyCa();
      console.log("Done. Browsers will now trust local TLS certificates.");
    } catch (err) {
      if (err instanceof TlsError) {
        console.error(err.message);
        process.exit(1);
      }
      throw err;
    }
  });
