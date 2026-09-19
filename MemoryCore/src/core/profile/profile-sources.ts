import { createHash } from "node:crypto";
import type { StorageAdapter } from "../storage/adapter.js";
import { stripSceneNavigation } from "../scene/scene-navigation.js";

export type ProfileSources = { complete: boolean; messageIds: string[] };
const unknownSources = (): ProfileSources => ({ complete: false, messageIds: [] });
const sourceKey = (key: string) => `.metadata/profile-sources/${createHash("sha256").update(key).digest("hex")}.json`;
const contentHash = (key: string, content: string) => createHash("sha256")
  .update(key === "persona.md" ? stripSceneNavigation(content).trim() : content).digest("hex");

export function mergeProfileSources(sources: ProfileSources[]): ProfileSources {
  return { complete: sources.every(source => source.complete), messageIds: [...new Set(sources.flatMap(source => source.messageIds))] };
}

export async function readProfileSources(storage: StorageAdapter, key: string, content: string): Promise<ProfileSources> {
  const saved = await storage.readFile(sourceKey(key));
  if (!saved) return unknownSources();
  const record = JSON.parse(saved) as { hash: string; sources: ProfileSources };
  return record.hash === contentHash(key, content) ? record.sources : unknownSources();
}

export async function writeProfileSources(storage: StorageAdapter, key: string, content: string, sources: ProfileSources): Promise<void> {
  await storage.writeFile(sourceKey(key), JSON.stringify({ hash: contentHash(key, content), sources }));
}

/** Host-owned lineage; the model cannot author provenance by quoting a message ID. */
export function trackProfileSources(storage: StorageAdapter, initial: ProfileSources[], requireKnownSources = false) {
  const inputs = [...initial];
  const written = new Set<string>();
  const observed = new Map<string, string>();
  const observe = async (key: string, content: string | null) => {
    if (content === null || written.has(key)) return true;
    if (observed.get(key) === content) return true;
    const source = await readProfileSources(storage, key, content);
    if (requireKnownSources && !source.complete) return false;
    observed.set(key, content);
    inputs.push(source);
    return true;
  };
  const trackedStorage = new Proxy(storage, {
    get(target, property) {
      if (property === "readFile") return async (key: string) => {
        const content = await target.readFile(key);
        if (!await observe(key, content)) throw new Error("Profile source is unknown; use the verified inputs supplied in this generation.");
        return content;
      };
      if (property === "writeFile") return async (key: string, content: string) => {
        if (requireKnownSources && !written.has(key)) {
          const previous = await target.readFile(key);
          if (previous && !(await readProfileSources(target, key, previous)).complete) {
            const backup = createHash("sha256").update(key).update("\0").update(previous).digest("hex");
            await target.writeFile(`.metadata/unverified-profiles/${backup}.json`, JSON.stringify({key, content: previous}));
          }
        }
        await target.writeFile(key, content);
        written.add(key);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { storage: trackedStorage, observe, written, sources: () => mergeProfileSources(inputs) };
}
