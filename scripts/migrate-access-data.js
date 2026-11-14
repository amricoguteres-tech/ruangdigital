import "dotenv/config";
import { closeDatabase, db } from "../database.js";
import { loadAccessDataKeyring, migrateAccessDataRows } from "../access-data.js";

try {
  const keyring = loadAccessDataKeyring(process.env, true);
  const migrated = migrateAccessDataRows(db, keyring);
  console.info(`Encrypted or rotated access details for ${migrated} order(s).`);
} finally {
  closeDatabase();
}
