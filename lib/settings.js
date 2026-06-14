import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { getDataDir, getSessionSecret } from "./auth.js";

const SETTINGS_FILENAME = "settings.enc";
const ALGORITHM = "aes-256-gcm";
const VERSION = 1;
const SUPPORTED_PROVIDERS = new Set(["hetzner", "hostinger"]);

const DEFAULT_SETTINGS = {
  activeConnectionId: "",
  connections: [],
  poste: {
    baseUrl: "http://poste",
    adminEmail: "",
    adminPassword: "",
    mailHost: "",
  },
};

let settings = structuredClone(DEFAULT_SETTINGS);

function settingsFilePath() {
  return path.join(getDataDir(), SETTINGS_FILENAME);
}

async function encryptionKey() {
  const secret = await getSessionSecret();
  return crypto.createHash("sha256").update(secret).digest();
}

function normalizeConnection(connection = {}) {
  return {
    id: String(connection.id || crypto.randomUUID()),
    name: String(connection.name || "").trim(),
    provider: String(connection.provider || "").trim(),
    apiKey: String(connection.apiKey || connection.apiToken || "").trim(),
    createdAt: connection.createdAt || new Date().toISOString(),
  };
}

function legacyConnections(value) {
  const connections = [];
  const hetznerKey = value.providers?.hetzner?.apiKey;
  const hostingerToken = value.providers?.hostinger?.apiToken;

  if (hetznerKey) {
    connections.push(
      normalizeConnection({
        id: "legacy-hetzner",
        name: "Hetzner",
        provider: "hetzner",
        apiKey: hetznerKey,
      })
    );
  }
  if (hostingerToken) {
    connections.push(
      normalizeConnection({
        id: "legacy-hostinger",
        name: "Hostinger",
        provider: "hostinger",
        apiKey: hostingerToken,
      })
    );
  }
  return connections;
}

function mergeDefaults(value = {}) {
  const connections = Array.isArray(value.connections)
    ? value.connections.map(normalizeConnection)
    : legacyConnections(value);
  let activeConnectionId = String(value.activeConnectionId || "");

  if (!connections.some((connection) => connection.id === activeConnectionId)) {
    const legacyActive = connections.find(
      (connection) => connection.provider === value.activeProvider
    );
    activeConnectionId = legacyActive?.id || connections[0]?.id || "";
  }

  return {
    activeConnectionId,
    connections,
    poste: {
      ...DEFAULT_SETTINGS.poste,
      ...value.poste,
    },
  };
}

async function writeSettings(value) {
  const key = await encryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(value));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const payload = {
    version: VERSION,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: encrypted.toString("base64"),
  };

  await fs.mkdir(getDataDir(), { recursive: true });
  await fs.writeFile(settingsFilePath(), JSON.stringify(payload), { mode: 0o600 });
}

function publicConnection(connection) {
  return {
    id: connection.id,
    name: connection.name,
    provider: connection.provider,
    configured: Boolean(connection.apiKey),
    createdAt: connection.createdAt,
  };
}

function validateConnectionInput(input) {
  const name = String(input.name || "").trim();
  const provider = String(input.provider || "").trim();
  const apiKey = String(input.apiKey || input.apiToken || "").trim();
  if (!name) {
    const err = new Error("Connection name is required");
    err.status = 400;
    throw err;
  }
  if (!SUPPORTED_PROVIDERS.has(provider)) {
    const err = new Error("Choose Hetzner or Hostinger");
    err.status = 400;
    throw err;
  }
  if (!apiKey) {
    const err = new Error("API key is required");
    err.status = 400;
    throw err;
  }
  return { name, provider, apiKey };
}

export async function loadSettings() {
  try {
    const raw = await fs.readFile(settingsFilePath(), "utf8");
    const payload = JSON.parse(raw);
    const key = await encryptionKey();
    const decipher = crypto.createDecipheriv(
      ALGORITHM,
      key,
      Buffer.from(payload.iv, "base64")
    );
    decipher.setAuthTag(Buffer.from(payload.tag, "base64"));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(payload.data, "base64")),
      decipher.final(),
    ]);
    settings = mergeDefaults(JSON.parse(decrypted.toString("utf8")));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    settings = structuredClone(DEFAULT_SETTINGS);
  }
  await writeSettings(settings);
  return getSettings();
}

export function getSettings() {
  return structuredClone(settings);
}

export function getConnection(connectionId) {
  const connection = settings.connections.find(
    (item) => item.id === String(connectionId || settings.activeConnectionId)
  );
  return connection ? structuredClone(connection) : null;
}

export function getPublicSettings() {
  const activeConnection = getConnection(settings.activeConnectionId);
  return {
    activeConnectionId: settings.activeConnectionId,
    activeProvider: activeConnection?.provider || "",
    connections: settings.connections.map(publicConnection),
    poste: {
      configured: Boolean(
        settings.poste.baseUrl &&
          settings.poste.adminEmail &&
          settings.poste.adminPassword
      ),
      baseUrl: settings.poste.baseUrl,
      adminEmail: settings.poste.adminEmail,
      mailHost: settings.poste.mailHost,
    },
  };
}

export async function addConnection(input = {}) {
  const connection = normalizeConnection(validateConnectionInput(input));
  settings.connections.push(connection);
  if (!settings.activeConnectionId) settings.activeConnectionId = connection.id;
  await writeSettings(settings);
  return publicConnection(connection);
}

export async function deleteConnection(connectionId) {
  const index = settings.connections.findIndex(
    (connection) => connection.id === String(connectionId)
  );
  if (index === -1) {
    const err = new Error("Connection not found");
    err.status = 404;
    throw err;
  }
  settings.connections.splice(index, 1);
  if (settings.activeConnectionId === String(connectionId)) {
    settings.activeConnectionId = settings.connections[0]?.id || "";
  }
  await writeSettings(settings);
  return getPublicSettings();
}

export async function updateSettings(input = {}) {
  const next = mergeDefaults(settings);
  if (input.activeConnectionId !== undefined) {
    const id = String(input.activeConnectionId);
    if (id && !next.connections.some((connection) => connection.id === id)) {
      const err = new Error("Connection not found");
      err.status = 404;
      throw err;
    }
    next.activeConnectionId = id;
  }

  for (const field of ["baseUrl", "adminEmail", "adminPassword", "mailHost"]) {
    const value = input.poste?.[field];
    if (value !== undefined) {
      next.poste[field] = String(value).trim();
    }
  }

  next.poste.baseUrl = next.poste.baseUrl.replace(/\/$/, "");
  settings = next;
  await writeSettings(settings);
  return getPublicSettings();
}
