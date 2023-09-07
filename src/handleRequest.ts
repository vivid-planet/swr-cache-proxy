import { Request, Response } from "express";

import { CacheBackend, parseMeta } from "./cache";

interface Options {
    origin: string;
    cache: CacheBackend;
}

export async function handleRequest(req: Request, res: Response, { origin, cache }: Options) {
    const cacheKey = req.url;

    const cacheEntry = await cache.get(cacheKey);
    const cacheBody = cacheEntry ? cacheEntry[0] : null;
    const cacheMeta = cacheEntry ? cacheEntry[1] : null;
    const age = cacheMeta ? new Date().getTime() - cacheMeta.mtime : null;
    //console.log("request", req.url, age, cacheMeta);

    if (age && cacheMeta && (age < cacheMeta.maxAge || (cacheMeta.staleWhileRevalidate && age < cacheMeta.staleWhileRevalidate))) {
        console.log("serving from cache", req.url);
        const shouldRevalidate = cacheMeta.staleWhileRevalidate && age > cacheMeta.maxAge;
        if (shouldRevalidate) {
            res.setHeader("X-Cache", "HIT, REVALIDATE");
        } else {
            res.setHeader("X-Cache", "HIT");
        }
        //res.status(200);

        res.send(cacheBody);
        res.end();

        // Asynchronously revalidate the cache in the background
        if (shouldRevalidate) {
            console.log("async refresh", req.url);
            const freshResponse = await fetch(`${origin}${req.url}`, {
                method: req.method,
                //headers: req.headers,
                body: req.method === "GET" ? undefined : req.body,
            });

            const freshResponseBody = await freshResponse.text();

            // Update the cache with the fresh response
            const meta = parseMeta(freshResponse);
            if (meta) {
                //if null it's uncachable
                cache.set(cacheKey, freshResponseBody, meta); //don't await
            }
        }
    } else {
        console.log("serving live", req.url);

        // Fetch the response from the fixed target URL
        const response = await fetch(`${origin}${req.url}`, {
            method: req.method,
            //headers: req.headers,
            body: req.method === "GET" ? undefined : req.body,
        });

        const responseBody = await response.text();

        // Cache the response
        const meta = parseMeta(response);
        if (meta) {
            //if null it's uncachable
            cache.set(cacheKey, responseBody, meta); //don't await
        }

        res.setHeader("X-Cache", "MISS");
        // Send the response to the client
        //res.status(response.status);
        //res.set(response.headers);
        res.send(responseBody);
        res.end();
    }
}
