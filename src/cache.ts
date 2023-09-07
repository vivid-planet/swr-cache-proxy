import fs from "fs-extra";
import path from "path";

export interface CacheBackend {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    getMtime(key: string): Promise<Date | null>;
}

export class FilesystemCacheBackend implements CacheBackend {
    constructor(private cacheDir: string) {
        fs.ensureDirSync(cacheDir);
    }
    async get(key: string): Promise<string | null> {
        const cacheFilePath = path.join(this.cacheDir, encodeURIComponent(key));
        if (!(await fs.exists(cacheFilePath))) return null;
        return fs.readFile(cacheFilePath, "utf-8"); //TODO streaming, error handling
    }
    async set(key: string, value: string): Promise<void> {
        const cacheFilePath = path.join(this.cacheDir, encodeURIComponent(key));
        return fs.writeFile(cacheFilePath, value); //TODO streaming, error handling
    }
    async getMtime(key: string): Promise<Date | null> {
        const cacheFilePath = path.join(this.cacheDir, encodeURIComponent(key));
        if (!(await fs.exists(cacheFilePath))) return null;
        const stat = await fs.stat(cacheFilePath);
        return stat.mtime;
    }
}
