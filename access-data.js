import crypto from "node:crypto";

const envelopePrefix = "rd-access";
const envelopeFormatVersion = "1";
const additionalData = Buffer.from("ruangdigital:service-access:v1");
const keyVersionPattern = /^v[1-9]\d*$/;

function decodeKey(value, variableName) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(value)) {
    throw new Error(`${variableName} must be a base64-encoded 32-byte key.`);
  }
  const key = Buffer.from(value, "base64");
  if (key.length !== 32 || key.toString("base64") !== value) {
    throw new Error(`${variableName} must be a base64-encoded 32-byte key.`);
  }
  return key;
}

export function loadAccessDataKeyring(environment = process.env, required = false) {
  const activeVersion = environment.ACCESS_DATA_KEY_VERSION || "v1";
  if (!keyVersionPattern.test(activeVersion)) {
    throw new Error("ACCESS_DATA_KEY_VERSION must use a version such as v1.");
  }

  const keys = new Map();
  for (const [name, value] of Object.entries(environment)) {
    const match = name.match(/^ACCESS_DATA_KEY_(V[1-9]\d*)$/);
    if (match && value) keys.set(match[1].toLowerCase(), decodeKey(value, name));
  }

  if (environment.ACCESS_DATA_KEY) {
    const activeKey = decodeKey(environment.ACCESS_DATA_KEY, "ACCESS_DATA_KEY");
    const versionedKey = keys.get(activeVersion);
    if (versionedKey && !crypto.timingSafeEqual(versionedKey, activeKey)) {
      throw new Error(`ACCESS_DATA_KEY conflicts with ACCESS_DATA_KEY_${activeVersion.toUpperCase()}.`);
    }
    keys.set(activeVersion, activeKey);
  }

  if (!keys.has(activeVersion)) {
    if (required) throw new Error("ACCESS_DATA_KEY must be configured in production.");
    return { activeVersion: null, keys };
  }
  return { activeVersion, keys };
}

export function encryptAccessData(value, keyring) {
  if (!keyring?.activeVersion || !keyring.keys.has(keyring.activeVersion)) {
    throw new Error("Access-data encryption key is not configured.");
  }
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyring.keys.get(keyring.activeVersion), nonce);
  cipher.setAAD(additionalData);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    envelopePrefix,
    envelopeFormatVersion,
    keyring.activeVersion,
    nonce.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

export function decryptAccessData(envelope, keyring) {
  if (typeof envelope !== "string") throw new Error("Encrypted access data is invalid.");
  const [prefix, formatVersion, keyVersion, nonceText, tagText, ciphertextText, extra] = envelope.split(":");
  if (prefix !== envelopePrefix || formatVersion !== envelopeFormatVersion ||
      !keyVersionPattern.test(keyVersion || "") || !nonceText || !tagText || !ciphertextText || extra !== undefined) {
    throw new Error("Encrypted access data is invalid.");
  }
  const key = keyring?.keys.get(keyVersion);
  if (!key) throw new Error(`Encryption key ${keyVersion} is unavailable.`);

  try {
    const nonce = Buffer.from(nonceText, "base64");
    const tag = Buffer.from(tagText, "base64");
    const ciphertext = Buffer.from(ciphertextText, "base64");
    if (nonce.length !== 12 || tag.length !== 16) throw new Error("Invalid encrypted access data.");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(additionalData);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
    return JSON.parse(plaintext);
  } catch {
    throw new Error("Encrypted access data could not be authenticated.");
  }
}

export function migrateAccessDataRows(database, keyring) {
  if (!keyring?.activeVersion || !keyring.keys.has(keyring.activeVersion)) {
    throw new Error("Access-data encryption key is not configured.");
  }
  const rows = database.prepare(`
    SELECT id, service_details AS serviceDetails FROM orders
    WHERE service_details IS NOT NULL AND service_details != ''
  `).all();
  const update = database.prepare("UPDATE orders SET service_details = ? WHERE id = ?");
  const migrate = database.transaction(() => {
    for (const row of rows) {
      const value = row.serviceDetails.startsWith(`${envelopePrefix}:`)
        ? decryptAccessData(row.serviceDetails, keyring)
        : JSON.parse(row.serviceDetails);
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Access details for order ${row.id} are not a JSON object.`);
      }
      update.run(encryptAccessData(value, keyring), row.id);
    }
    return rows.length;
  });
  return migrate();
}
