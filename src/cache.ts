import { ReadableStream } from "node:stream/web";

import fs from "fs-extra";
import path from "path";
import { Readable } from "stream";
import { finished } from "stream/promises";
import { Headers, Response } from "undici";

export interface CacheMeta {
    maxAge: number;
    staleWhileRevalidate?: number;
    headers: Record<string, string>;
    status: number;
}

export interface CacheMetaWithMtime extends CacheMeta {
    mtime: number;
}

export function convertHeadersToObject(headers: Headers): Record<string, string> {
    return Array.from(headers).reduce((headers, [key, value]) => ({ [key]: value, ...headers }), {} as Record<string, string>);
}

export function parseMeta(res: Response): CacheMeta | null {
    if (![200, 301, 302].includes(res.status)) return null;

    const cacheControl = res.headers.get("cache-control");
    if (!cacheControl) {
        return null;
    }
    const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
    if (!maxAgeMatch) {
        return null;
    }

    const status = res.status;
    const headers = convertHeadersToObject(res.headers);

    const maxAge = parseInt(maxAgeMatch[1], 10) * 1000;
    const staleWhileRevalidateMatch = cacheControl.match(/stale-while-revalidate=(\d+)/);
    if (!staleWhileRevalidateMatch) {
        return { maxAge, headers, status };
    }
    const staleWhileRevalidate = parseInt(staleWhileRevalidateMatch[1], 10) * 1000;
    return { maxAge, staleWhileRevalidate, headers, status };
}

export interface CacheBackend {
    get(key: string): Promise<[CacheMetaWithMtime, ReadableStream | null] | null>;
    set(key: string, body: ReadableStream | null, meta: CacheMeta): Promise<void>;
}

export class FilesystemCacheBackend implements CacheBackend {
    constructor(private cacheDir: string) {
        fs.ensureDirSync(cacheDir);
    }
    async get(key: string): Promise<[CacheMetaWithMtime, ReadableStream | null] | null> {
        const cacheFilePath = path.join(this.cacheDir, encodeURIComponent(key));
        if (!(await fs.exists(`${cacheFilePath}--meta`))) return null;

        const meta = JSON.parse(await fs.readFile(`${cacheFilePath}--meta`, "utf-8"));
        let body: ReadableStream | null = null;
        if (meta.hasBody) {
            const fileStream = fs.createReadStream(cacheFilePath, { flags: "r" });
            body = Readable.toWeb(fileStream);
        }
        return [meta, body];
    }
    async set(key: string, body: ReadableStream | null, meta: CacheMeta): Promise<void> {
        const cacheFilePath = path.join(this.cacheDir, encodeURIComponent(key));
        // console.log("writing cache", cacheFilePath, { ...meta, mtime: new Date().getTime() });
        await fs.writeFile(`${cacheFilePath}--meta`, JSON.stringify({ ...meta, mtime: new Date().getTime(), hasBody: !!body }));
        //TODO error handling
        if (body) {
            const fileStream = fs.createWriteStream(cacheFilePath, { flags: "w" });
            await finished(Readable.fromWeb(body).pipe(fileStream));
        }
    }
}
