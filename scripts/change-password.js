#!/usr/bin/env node
import readline from "readline/promises";
import { stdin as input, stdout as output } from "process";
import { changePassword, USERNAME } from "../lib/auth.js";

const rl = readline.createInterface({ input, output });

function readHidden(prompt) {
  return new Promise((resolve) => {
    output.write(prompt);
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      rl.question("").then(resolve);
      return;
    }

    stdin.setRawMode(true);
    stdin.resume();
    let value = "";

    const onData = (chunk) => {
      const char = chunk.toString("utf8");
      if (char === "\n" || char === "\r" || char === "\u0004") {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        output.write("\n");
        resolve(value);
        return;
      }
      if (char === "\u0003") process.exit(1);
      if (char === "\u007f" || char === "\b") {
        value = value.slice(0, -1);
        return;
      }
      value += char;
    };

    stdin.on("data", onData);
  });
}

async function main() {
  output.write(`PosteBridge password change (user: ${USERNAME})\n`);

  const password = await readHidden("New password: ");
  const confirm = await readHidden("Confirm password: ");

  if (password !== confirm) {
    console.error("Passwords do not match.");
    process.exit(1);
  }

  try {
    await changePassword(password);
    console.log("Password updated successfully.");
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  } finally {
    rl.close();
  }
}

main();
