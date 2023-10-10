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
    const maxAgeMatch = cacheControl.match(/(max-age|s-maxage)=(\d+)/);
    if (!maxAgeMatch) {
        return null;
    }

    const status = res.status;
    const headers = convertHeadersToObject(res.headers);

    const maxAge = parseInt(maxAgeMatch[2], 10) * 1000;
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
    delete(key: string): Promise<void>;
    startRefreshing(key: string): Promise<void>;
    isRefreshing(key: string): Promise<boolean>;
}

export class FilesystemCacheBackend implements CacheBackend {
    constructor(private cacheDir: string, private sizeLimit: number | null) {
        //create chacheDir if it doesn't exist
        fs.mkdir(cacheDir, { recursive: true });
        fs.mkdir(`${cacheDir}/bodies`, { recursive: true });

        this.cleanup(); // don't await
        setInterval(this.cleanup.bind(this), 1000 * 60 * 15);
    }

    private async cleanup() {
        const lastCleanupStarted = (await fs.exists(`${this.cacheDir}/cleanup`))
            ? parseInt(await fs.readFile(`${this.cacheDir}/cleanup`, "utf-8"))
            : null;
        if (lastCleanupStarted && new Date().getTime() - lastCleanupStarted < 1000 * 60 * 15 - 100) {
            console.log("skipping cleanup, already done by other process within 15 minutes: ", new Date().getTime() - lastCleanupStarted, "ms ago");
            return;
        }

        console.log("cleanup started");
        const cleanupStart = new Date().getTime();
        await fs.writeFile(`${this.cacheDir}/cleanup`, cleanupStart.toString());
        const stats = {
            deletedOutdated: 0,
            deletedOverSizeLimit: 0,
        };
        let entries = [];
        let sumSize = 0;
        const dir = await fs.opendir(this.cacheDir);
        for await (const file of dir) {
            if (file.isDirectory()) continue;
            if (file.name.endsWith("cleanup")) continue;
            if (file.name.endsWith("--temp")) continue;
            if (file.name.endsWith("--refreshing")) {
                let refreshingStarted;
                try {
                    refreshingStarted = parseInt(await fs.readFile(file.path, "utf-8"));
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                } catch (err: any) {
                    if (err.code === "ENOENT") {
                        // No Entity; file does not exist (can happen in race conditions where other request/process deleted the file)
                        // continue with next file
                        continue;
                    } else {
                        throw err;
                    }
                }
                if (new Date().getTime() - refreshingStarted > 60 * 1000) {
                    //refreshing started more than 60 seconds ago, so it's probably finished
                    try {
                        await fs.unlink(file.path);
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    } catch (err: any) {
                        if (err.code === "ENOENT") {
                            // No Entity; file does not exist (can happen in race conditions where other request/process deleted the file)
                            // continue with next file
                            continue;
                        } else {
                            throw err;
                        }
                    }
                }
            } else {
                //standard cache meta file
                let meta;
                try {
                    meta = await fs.readFile(file.path, "utf-8");
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                } catch (err: any) {
                    if (err.code === "ENOENT") {
                        // No Entity; file does not exist (can happen in race conditions where other request/process deleted the file)
                        // continue with next file
                        continue;
                    } else {
                        throw err;
                    }
                }
                meta = JSON.parse(meta);
                if (meta.mtime + meta.maxAge < new Date().getTime()) {
                    stats.deletedOutdated++;
                    await this.deleteCacheFile(file.name);
                } else {
                    let size = 0;
                    try {
                        const statMeta = await fs.stat(file.path);
                        size += statMeta.size;
                        if (meta.body) {
                            const statContent = await fs.stat(meta.body);
                            size += statContent.size;
                        }
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    } catch (err: any) {
                        if (err.code === "ENOENT") {
                            // No Entity; file does not exist (can happen in race conditions where other request/process deleted the file)
                            // continue with next file
                            continue;
                        } else {
                            throw err;
                        }
                    }
                    sumSize += size;
                    entries.push({ name: file.name, size, mtime: meta.mtime });
                }
            }
        }
        entries = entries.sort((a, b) => b.mtime - a.mtime); // oldest last
        while (this.sizeLimit && sumSize > this.sizeLimit) {
            const oldest = entries.pop();
            if (!oldest) break;
            stats.deletedOverSizeLimit++;
            await this.deleteCacheFile(oldest.name);
            sumSize -= oldest.size;
        }
        console.log("cleanup finished in", new Date().getTime() - cleanupStart, "ms", stats, "entries", entries.length, "size", sumSize);
    }

    async get(key: string): Promise<[CacheMetaWithMtime, ReadableStream | null] | null> {
        const cacheFilePath = path.join(this.cacheDir, encodeURIComponent(key));

        let meta;
        try {
            meta = await fs.readFile(cacheFilePath, "utf-8");
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
            if (err.code === "ENOENT") {
                // No Entity; file does not exist (catch error instead of calling exists before readFile to avoid race conditions)
                return null;
            } else {
                throw err;
            }
        }
        meta = JSON.parse(meta);

        let body: ReadableStream | null = null;
        if (meta.body) {
            let fileStream: fs.ReadStream;
            try {
                fileStream = fs.createReadStream(meta.body, { flags: "r" });
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } catch (err: any) {
                if (err.code === "ENOENT") {
                    // No Entity; file does not exist (can happen in race conditions where other request/process deleted the file)
                    return null;
                } else {
                    throw err;
                }
            }
            body = Readable.toWeb(fileStream);
        }
        return [meta, body];
    }

    async set(key: string, bodyStream: ReadableStream | null, meta: CacheMeta): Promise<void> {
        const cacheFilePath = path.join(this.cacheDir, encodeURIComponent(key));
        let bodyFile = null;
        const bodyDir = `${this.cacheDir}/bodies/${encodeURIComponent(key)}`;
        if (bodyStream) {
            await fs.mkdir(bodyDir, { recursive: true });
            //generate a unique filename to avoid overwriting the current cache body
            bodyFile = `${bodyDir}/${Math.random().toString(36).substring(2)}`;
            let fileStream: fs.WriteStream;
            try {
                fileStream = fs.createWriteStream(bodyFile, { flags: "w" });
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } catch (err: any) {
                if (err.code === "ENOENT") {
                    // No Entity; directory does not exist (can happen in very rare race conditions cache entry including body directory was deleted by other request/process)
                    return;
                } else {
                    throw err;
                }
            }

            await finished(Readable.fromWeb(bodyStream).pipe(fileStream));
        }

        //first write into a tempFile
        const tempFile = `${cacheFilePath}--${Math.random().toString(36).substring(2)}--temp`;
        await fs.writeFile(tempFile, JSON.stringify({ ...meta, mtime: new Date().getTime(), body: bodyFile }));

        //then rename the tempFile to the actual cache file (=atomic operation)
        await fs.rename(tempFile, cacheFilePath);

        //delete refreshing file, if there is any
        try {
            await fs.unlink(`${cacheFilePath}--refreshing`);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
            if (err.code === "ENOENT") {
                // No Entity; file does not exist (can happen in race conditions where other request/process deleted the file)
                // ignore error
            } else {
                throw err;
            }
        }

        //after writing new meta file, delete all other (old) body files
        let dir: fs.Dir;
        try {
            dir = await fs.opendir(bodyDir);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
            if (err.code === "ENOENT") {
                // No Entity; directory does not exist (can happen when there is no body)
                // return as nothing to delete
                return;
            } else {
                throw err;
            }
        }
        for await (const file of dir) {
            if (file.path !== bodyFile) {
                try {
                    await fs.unlink(file.path);
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                } catch (err: any) {
                    if (err.code === "ENOENT") {
                        // No Entity; file does not exist (can happen when in race condition when other request/process deleted the file)
                        // continue with next file
                    } else {
                        throw err;
                    }
                }
            }
        }
    }

    async delete(key: string): Promise<void> {
        return this.deleteCacheFile(encodeURIComponent(key));
    }

    private async deleteCacheFile(file: string): Promise<void> {
        const cacheFilePath = path.join(this.cacheDir, file);
        const bodyDir = `${this.cacheDir}/bodies/${file}`;
        try {
            await fs.unlink(`${cacheFilePath}`);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
            if (err.code === "ENOENT") {
                // No Entity; file does not exist (can happen in race conditions where other request/process deleted the file)
                // return as nothing to delete
                return;
            } else {
                throw err;
            }
        }
        let dir: fs.Dir;
        try {
            dir = await fs.opendir(bodyDir);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
            if (err.code === "ENOENT") {
                // No Entity; directory does not exist (can happen when there is no body)
                // return as nothing to delete
                return;
            } else {
                throw err;
            }
        }
        for await (const file of dir) {
            try {
                await fs.unlink(file.path);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } catch (err: any) {
                if (err.code === "ENOENT") {
                    // No Entity; file does not exist (can happen when in race condition when other request/process deleted the file)
                    // continue with next file
                } else {
                    throw err;
                }
            }
        }
        try {
            await fs.rmdir(bodyDir);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
            if (err.code === "ENOENT") {
                // No Entity; directory does not exist (can happen when in race condition when other request/process deleted the file)
                // ignore error
            } else {
                throw err;
            }
        }
    }
    async startRefreshing(key: string): Promise<void> {
        const cacheFilePath = path.join(this.cacheDir, encodeURIComponent(key));
        await fs.writeFile(`${cacheFilePath}--refreshing`, new Date().getTime().toString());
    }

    async isRefreshing(key: string): Promise<boolean> {
        const cacheFilePath = path.join(this.cacheDir, encodeURIComponent(key));
        let refreshingStarted;
        try {
            refreshingStarted = parseInt(await fs.readFile(`${cacheFilePath}--refreshing`, "utf-8"));
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
            if (err.code === "ENOENT") {
                // No Entity; file does not exist (catch error instead of calling exists before readFile to avoid race conditions)
                return false;
            } else {
                throw err;
            }
        }
        if (new Date().getTime() - refreshingStarted > 60 * 1000) {
            //refreshing started more than 60 seconds ago, process crashed or something, ignore it
            return false;
        } else {
            return true;
        }
    }
}
