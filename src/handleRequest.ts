import { Request, Response } from "express";
import fs from "fs-extra";
import path from "path";

const revalidateAfter = 5 * 60; // todo infer from cache-control header
const maxAge = 24 * 60 * 60; // todo infer from cache-control header

// Define a function to generate a cache key from the request URL
function getCacheKey(url: string): string {
    return encodeURIComponent(url);
}

async function isCacheFileValid(cacheFilePath: string) {
    if (!(await fs.existsSync(cacheFilePath))) return false;
    const stat = await fs.stat(cacheFilePath);
    if (new Date().getTime() - stat.mtime.getTime() > 1000 * maxAge) return false;
    return true;
}

interface Options {
    origin: string;
    cacheDir: string;
}

export async function handleRequest(req: Request, res: Response, { origin, cacheDir }: Options) {
    const cacheKey = getCacheKey(req.url);
    const cacheFilePath = path.join(cacheDir, cacheKey);

    // Check if the response is cached
    if (await isCacheFileValid(cacheFilePath)) {
        console.log("serving from cache", req.url);
        const cachedResponse = await fs.readFile(cacheFilePath, "utf-8");
        //res.status(200);
        res.send(cachedResponse);

        // Asynchronously revalidate the cache in the background
        (async () => {
            const stat = await fs.stat(cacheFilePath);
            if (new Date().getTime() - stat.mtime.getTime() > 1000 * revalidateAfter) {
                console.log("async refresh", req.url);
                const freshResponse = await fetch(`${origin}${req.url}`, {
                    method: req.method,
                    //headers: req.headers,
                    body: req.method === "GET" ? undefined : req.body,
                });

                const freshResponseBody = await freshResponse.text();

                // Update the cache with the fresh response
                await fs.writeFile(cacheFilePath, freshResponseBody);
            }
        })();
    } else {
        console.log("fetching", req.url);

        // Fetch the response from the fixed target URL
        const response = await fetch(`${origin}${req.url}`, {
            method: req.method,
            //headers: req.headers,
            body: req.method === "GET" ? undefined : req.body,
        });

        const responseBody = await response.text();

        // Cache the response
        await fs.writeFile(cacheFilePath, responseBody);

        // Send the response to the client
        //res.status(response.status);
        //res.set(response.headers);
        res.send(responseBody);
    }
}
