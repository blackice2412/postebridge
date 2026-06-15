#!/usr/bin/env node
import { resetRootPassword } from "../lib/auth.js";

async function main() {
  try {
    const { username, password } = await resetRootPassword();
    console.log("");
    console.log("══════════════════════════════════════════════════");
    console.log(" PosteBridge — new root password");
    console.log(` Username: ${username}`);
    console.log(` Password: ${password}`);
    console.log(" Save this password — it won't be shown again.");
    console.log(" Existing sessions stay valid until they expire.");
    console.log("══════════════════════════════════════════════════");
    console.log("");
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

main();
