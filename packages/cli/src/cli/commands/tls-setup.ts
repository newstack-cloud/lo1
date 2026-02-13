import { Command } from "commander";

export const tlsSetupCommand = new Command("tls-setup")
  .description("Generate locally-trusted TLS certificates via mkcert")
  .action(async () => {
    console.log("Setting up local TLS certificates...");
    // TODO: L3 — mkcert cert generation
  });
