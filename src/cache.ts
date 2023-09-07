import fs from "fs-extra";
import path from "path";

export interface CacheMeta {
    maxAge: number;
    staleWhileRevalidate?: number;
}

export interface CacheMetaWithMtime extends CacheMeta {
    mtime: number;
}

export function parseMeta(res: Response): CacheMeta | null {
    const cacheControl = res.headers.get("cache-control");
    if (!cacheControl) {
        return null;
    }
    const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
    if (!maxAgeMatch) {
        return null;
    }
    const maxAge = parseInt(maxAgeMatch[1], 10) * 1000;
    const staleWhileRevalidateMatch = cacheControl.match(/stale-while-revalidate=(\d+)/);
    if (!staleWhileRevalidateMatch) {
        return { maxAge };
    }
    const staleWhileRevalidate = parseInt(staleWhileRevalidateMatch[1], 10) * 1000;
    return { maxAge, staleWhileRevalidate };
}

export interface CacheBackend {
    get(key: string): Promise<[string, CacheMetaWithMtime] | null>;
    set(key: string, body: string, meta: CacheMeta): Promise<void>;
}

export class FilesystemCacheBackend implements CacheBackend {
    constructor(private cacheDir: string) {
        fs.ensureDirSync(cacheDir);
    }
    async get(key: string): Promise<[string, CacheMetaWithMtime] | null> {
        const cacheFilePath = path.join(this.cacheDir, encodeURIComponent(key));
        if (!(await fs.exists(cacheFilePath))) return null;
        const body = await fs.readFile(cacheFilePath, "utf-8"); //TODO streaming, error handling;
        const meta = await fs.readFile(`${cacheFilePath}--meta`, "utf-8");
        return [body, JSON.parse(meta)];
    }
    async set(key: string, body: string, meta: CacheMeta): Promise<void> {
        const cacheFilePath = path.join(this.cacheDir, encodeURIComponent(key));
        console.log("writing cache", cacheFilePath, { ...meta, mtime: new Date().getTime() });
        await fs.writeFile(`${cacheFilePath}--meta`, JSON.stringify({ ...meta, mtime: new Date().getTime() }));
        return fs.writeFile(cacheFilePath, body); //TODO streaming, error handling
    }
}
