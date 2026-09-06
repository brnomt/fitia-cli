import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CliError } from "./errors.ts";
import type { SavedSession, SessionStore } from "./keychain.ts";

const SESSION_FILE = "session.json";

function storeError(hint = "Check FITIA_DATA_DIR permissions and retry.") {
  return new CliError("SESSION_STORE_ERROR", "Could not access the saved Fitia session file.", hint, 5);
}

export function parseSavedSession(value: unknown): SavedSession {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw storeError("The session file is not valid JSON.");
  const data = value as Record<string, unknown>;
  if (
    data.version !== 1 ||
    typeof data.idToken !== "string" ||
    typeof data.refreshToken !== "string" ||
    typeof data.uid !== "string" ||
    !(data.email === null || typeof data.email === "string")
  ) {
    throw storeError("The session file is missing required fields.");
  }
  return {
    version: 1,
    idToken: data.idToken,
    refreshToken: data.refreshToken,
    uid: data.uid,
    email: data.email,
  };
}

export function fileStore(directory = process.env.FITIA_DATA_DIR ?? "/app/data"): SessionStore {
  if (!directory || directory.includes("\0")) throw storeError("FITIA_DATA_DIR is invalid.");
  const dir = resolve(directory);
  const file = join(dir, SESSION_FILE);
  const temp = `${file}.tmp`;

  async function ensureDir() {
    await mkdir(dir, { recursive: true });
    await chmod(dir, 0o700).catch(() => {});
  }

  return {
    async read() {
      let raw: string;
      try {
        raw = await readFile(file, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw storeError();
      }
      try {
        return parseSavedSession(JSON.parse(raw));
      } catch (error) {
        if (error instanceof CliError) throw error;
        throw storeError("The session file is not valid JSON.");
      }
    },
    async save(session) {
      parseSavedSession(session);
      try {
        await ensureDir();
        const payload = `${JSON.stringify(session)}\n`;
        await writeFile(temp, payload, { encoding: "utf8", mode: 0o600 });
        await chmod(temp, 0o600).catch(() => {});
        await rename(temp, file);
        await chmod(file, 0o600).catch(() => {});
      } catch (error) {
        await unlink(temp).catch(() => {});
        if (error instanceof CliError) throw error;
        throw storeError();
      }
    },
    async remove() {
      try {
        await unlink(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw storeError();
      }
    },
  };
}
