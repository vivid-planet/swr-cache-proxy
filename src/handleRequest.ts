import { Request, Response } from "express";

import { CacheBackend, convertHeadersToObject, parseMeta } from "./cache";

interface Options {
    origin: string;
    cache: CacheBackend;
}

function convertIncomingHeadersToHeadersInit(incomingHeaders: Request["headers"]): Record<string, string> {
    //Record<string, string | string[] | undefined>
    return Object.entries(incomingHeaders).reduce((headers, [key, value]) => {
        if (value) {
            return {
                [key]: Array.isArray(value) ? value.join(", ") : value, //TODO this is not correct
                ...headers,
            };
        } else {
            return headers;
        }
    }, {} as Record<string, string>);
}

async function passThru(req: Request, res: Response, { origin }: Options) {
    const freshResponse = await fetch(`${origin}${req.url}`, {
        method: req.method,
        headers: convertIncomingHeadersToHeadersInit(req.headers),
        body: req.body,
    });

    const responseBody = await freshResponse.text();

    // Send the response to the client
    res.set(convertHeadersToObject(freshResponse.headers));
    res.appendHeader("X-Cache", "BYPASS");
    res.appendHeader("Via", "swr-cache-proxy");
    res.status(freshResponse.status);
    res.send(responseBody);
    res.end();
}

interface OriginFetchOptions {
    acceptEncoding: string | undefined;
}
async function originFetch(req: Request, { acceptEncoding }: OriginFetchOptions, { origin }: Options) {
    const headers = {
        "accept-encoding": acceptEncoding, //part of cache-key
        //don't pass thru any other headers (eg user-agent)
    };

    const fetchResponse = await fetch(`${origin}${req.url}`, {
        method: req.method,
        headers: convertIncomingHeadersToHeadersInit(headers),
        body: req.body,
    });
    if (fetchResponse.headers.get("set-cookie")) {
        console.log("set-cookie header from origin, dropping");
        fetchResponse.headers.delete("set-cookie");
    }
    return fetchResponse;
}

export function normalizedAcceptEncoding(req: Request): string | undefined {
    // idea from https://varnish-cache.org/docs/3.0/tutorial/vary.html
    if (req.url.match(/\.(jpg|jpeg|png|gif|mp3|ogg|mp4|pdf|zip)$/)) {
        // No point in compressing these
        return undefined;
    } else if (req.acceptsEncodings("br")) {
        return "br";
    } else if (req.acceptsEncodings("gzip")) {
        return "gzip";
    } else if (req.acceptsEncodings("deflate")) {
        return "deflate";
    } else {
        // unknown algorithm
        return undefined;
    }
}

export async function handleRequest(req: Request, res: Response, { origin, cache }: Options) {
    if (req.headers["authorization"]) {
        res.status(500);
        res.send("authorization header not allowed");
        res.end();
        return;
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
        passThru(req, res, { origin, cache });
        return;
    }
    const acceptEncoding = normalizedAcceptEncoding(req);
    const cacheKey = `${req.method}--${req.url}--${acceptEncoding ?? ""}`;

    const cacheEntry = await cache.get(cacheKey);
    const cacheBody = cacheEntry ? cacheEntry[0] : null;
    const cacheMeta = cacheEntry ? cacheEntry[1] : null;
    const age = cacheMeta ? new Date().getTime() - cacheMeta.mtime : null;

    if (age && cacheMeta && (age < cacheMeta.maxAge || (cacheMeta.staleWhileRevalidate && age < cacheMeta.staleWhileRevalidate))) {
        console.log("serving from cache", req.url);
        const shouldRevalidate = cacheMeta.staleWhileRevalidate && age > cacheMeta.maxAge;
        res.appendHeader("X-Cache", "HIT");
        if (shouldRevalidate) {
            res.appendHeader("X-Age", `${String(age)} revalidate`);
        } else {
            res.appendHeader("X-Age", String(age));
        }
        res.appendHeader("Via", "swr-cache-proxy");
        res.status(cacheMeta.status);
        res.set(cacheMeta.headers);

        res.send(cacheBody);
        res.end();

        // Asynchronously revalidate the cache in the background
        if (shouldRevalidate) {
            console.log("async refresh", req.url);

            const freshResponse = await originFetch(req, { acceptEncoding }, { origin, cache });
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
        const response = await originFetch(req, { acceptEncoding }, { origin, cache });

        const responseBody = await response.text();

        // Cache the response
        const meta = parseMeta(response);
        if (meta) {
            //if null it's uncachable
            cache.set(cacheKey, responseBody, meta); //don't await
            res.appendHeader("X-Cache", "MISS");
        } else {
            res.appendHeader("X-Cache", "BYPASS");
        }

        // Send the response to the client
        res.set(convertHeadersToObject(response.headers));

        res.appendHeader("Via", "swr-cache-proxy");
        res.status(response.status);
        res.send(responseBody);
        res.end();
    }
}
