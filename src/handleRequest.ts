import { Request, Response } from "express";

import { CacheBackend } from "./cache";

const revalidateAfter = 5 * 60; // todo infer from cache-control header
const maxAge = 24 * 60 * 60; // todo infer from cache-control header

interface Options {
    origin: string;
    cache: CacheBackend;
}

export async function handleRequest(req: Request, res: Response, { origin, cache }: Options) {
    const cacheKey = req.url;

    // Check if the response is cached
    const mtime = await cache.getMtime(cacheKey);
    if (mtime && new Date().getTime() - mtime.getTime() < 1000 * maxAge) {
        console.log("serving from cache", req.url);
        const cachedResponse = await cache.get(cacheKey);
        console.log(cachedResponse);
        //res.status(200);
        res.send(cachedResponse);

        // Asynchronously revalidate the cache in the background
        (async () => {
            if (!mtime || new Date().getTime() - mtime.getTime() > 1000 * revalidateAfter) {
                console.log("async refresh", req.url);
                const freshResponse = await fetch(`${origin}${req.url}`, {
                    method: req.method,
                    //headers: req.headers,
                    body: req.method === "GET" ? undefined : req.body,
                });

                const freshResponseBody = await freshResponse.text();

                // Update the cache with the fresh response
                cache.set(cacheKey, freshResponseBody); //don't await
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
        cache.set(cacheKey, responseBody); //don't await

        // Send the response to the client
        //res.status(response.status);
        //res.set(response.headers);
        res.send(responseBody);
    }
}
