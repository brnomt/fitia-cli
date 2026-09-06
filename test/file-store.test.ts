import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileStore, type SavedSession } from "@fitia/core";

const session: SavedSession = {
  version: 1,
  idToken: "e30.e30.sig",
  refreshToken: "refresh",
  uid: "test-user",
  email: "example@example.invalid",
};

async function directory() {
  return mkdtemp(join(tmpdir(), "fitia-session-"));
}

test("file store round-trips a session atomically", async () => {
  const dir = await directory();
  try {
    const store = fileStore(dir);
    expect(await store.read()).toBeUndefined();
    await store.save(session);
    expect(await store.read()).toEqual(session);
    const raw = await readFile(join(dir, "session.json"), "utf8");
    expect(JSON.parse(raw)).toEqual(session);
    await store.remove();
    expect(await store.read()).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("file store rejects corrupt JSON instead of deleting it", async () => {
  const dir = await directory();
  try {
    await writeFile(join(dir, "session.json"), "{not-json", "utf8");
    await expect(fileStore(dir).read()).rejects.toMatchObject({ code: "SESSION_STORE_ERROR" });
    expect(await readFile(join(dir, "session.json"), "utf8")).toBe("{not-json");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("file store rejects a session missing required fields", async () => {
  const dir = await directory();
  try {
    await writeFile(join(dir, "session.json"), JSON.stringify({ version: 1, idToken: "x" }), "utf8");
    await expect(fileStore(dir).read()).rejects.toMatchObject({ code: "SESSION_STORE_ERROR" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
