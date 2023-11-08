import { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { ReadableStream } from "node:stream/web";

import fresh from "fresh";
import { fetch, HeadersInit } from "undici";

import { CacheBackend, parseMeta } from "./cache";

interface Options {
    origin: string;
    cache: CacheBackend;
}

function convertIncomingHeadersToHeadersInit(incomingHeaders: IncomingMessage["headers"]): HeadersInit {
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

async function passThru(req: IncomingMessage, res: ServerResponse, { origin }: Options) {
    const freshResponse = await fetch(`${origin}${req.url}`, {
        method: req.method,
        headers: convertIncomingHeadersToHeadersInit(req.headers),
        body: req.method !== "GET" && req.method != "HEAD" ? Readable.toWeb(req) : undefined,
        duplex: "half",
    });

    // Send the response to the client
    freshResponse.headers.forEach((value, key) => {
        res.setHeader(key, value);
    });
    res.appendHeader("X-Cache", "BYPASS");
    res.appendHeader("Via", "swr-cache-proxy");
    res.statusCode = freshResponse.status;
    if (freshResponse.body) {
        Readable.fromWeb(freshResponse.body).pipe(res, { end: true });
    } else {
        res.end();
    }
}

interface OriginFetchOptions {
    acceptEncoding: string | undefined;
}
async function originFetch(req: IncomingMessage, { acceptEncoding }: OriginFetchOptions, { origin }: Options) {
    const headers = {
        "accept-encoding": acceptEncoding, //part of cache-key
        //don't pass thru any other headers (eg user-agent)
    };

    const fetchResponse = await fetch(`${origin}${req.url}`, {
        method: req.method,
        headers: convertIncomingHeadersToHeadersInit(headers),
        body: req.method !== "GET" && req.method != "HEAD" ? Readable.toWeb(req) : undefined,
        duplex: "half",
    });
    if (fetchResponse.headers.get("set-cookie")) {
        console.log("set-cookie header from origin, dropping");
        fetchResponse.headers.delete("set-cookie");
    }
    return fetchResponse;
}

export function normalizedAcceptEncoding(req: IncomingMessage): string | undefined {
    // idea from https://varnish-cache.org/docs/3.0/tutorial/vary.html
    const acceptEncoding = String(req.headers["accept-encoding"]);
    if (req.url && req.url.match(/\.(jpg|jpeg|png|gif|mp3|ogg|mp4|pdf|zip)$/)) {
        // No point in compressing these
        return undefined;
    } else if (acceptEncoding.includes("br")) {
        return "br";
    } else if (acceptEncoding.includes("gzip")) {
        return "gzip";
    } else if (acceptEncoding.includes("deflate")) {
        return "deflate";
    } else {
        // unknown algorithm
        return undefined;
    }
}

export async function handleRequest(req: IncomingMessage, res: ServerResponse, { origin, cache }: Options) {
    // LivenessProbe for Kubernetes
    if (req.url === "/.well-known/liveness") {
        res.write("OK");
        res.end();
        return;
    }

    if (req.headers["authorization"]) {
        res.statusCode = 500;
        res.write("authorization header not allowed");
        res.end();
        return;
    }
    if (!req.method || !["GET", "HEAD", "OPTIONS"].includes(req.method)) {
        passThru(req, res, { origin, cache });
        return;
    }
    const acceptEncoding = normalizedAcceptEncoding(req);
    const cacheKey = `${req.method}--${req.url}--${acceptEncoding ?? ""}`;

    const cacheEntry = await cache.get(cacheKey);
    const cacheMeta = cacheEntry ? cacheEntry[0] : null;
    const cacheBody = cacheEntry ? cacheEntry[1] : null;
    const age = cacheMeta ? new Date().getTime() - cacheMeta.mtime : null;

    if (age && cacheMeta && (age < cacheMeta.maxAge || (cacheMeta.staleWhileRevalidate && age < cacheMeta.staleWhileRevalidate))) {
        console.log("serving from cache", age, req.url);
        const shouldRevalidate = cacheMeta.staleWhileRevalidate && age > cacheMeta.maxAge;
        res.appendHeader("X-Cache", "HIT");
        if (shouldRevalidate) {
            res.appendHeader("X-Age", `${String(Math.floor(age / 1000))} revalidate`);
        } else {
            res.appendHeader("X-Age", String(Math.floor(age / 1000)));
        }
        res.appendHeader("Via", "swr-cache-proxy");
        Object.entries(cacheMeta.headers).forEach(([key, value]) => {
            res.setHeader(key, value);
        });

        const isFresh = fresh(req.headers, {
            etag: cacheMeta.headers["etag"],
            "last-modified": cacheMeta.headers["last-modified"],
        });

        if (isFresh) {
            res.removeHeader("Content-Type");
            res.removeHeader("Content-Length");
            res.removeHeader("Transfer-Encoding");
            res.statusCode = 304;
            res.end();
        } else {
            res.statusCode = cacheMeta.status;

            if (cacheBody) {
                Readable.fromWeb(cacheBody).pipe(res, { end: true });
            } else {
                res.end();
            }
        }

        // Asynchronously revalidate the cache in the background
        if (shouldRevalidate && !(await cache.isRefreshing(cacheKey))) {
            console.log("async refresh", req.url);
            await cache.startRefreshing(cacheKey);

            const freshResponse = await originFetch(req, { acceptEncoding }, { origin, cache });

            // Update the cache with the fresh response
            const meta = parseMeta(freshResponse);
            if (meta) {
                //if not null it's cachable
                cache.set(cacheKey, freshResponse.body, meta); //don't await
            } else {
                //not cacheable anymore (was previously) so delete it
                cache.delete(cacheKey); //don't await
            }
        }
    } else {
        console.log("serving live", age, req.url);

        // Fetch the response from the fixed target URL
        const response = await originFetch(req, { acceptEncoding }, { origin, cache });

        let body1: ReadableStream | null = null;
        let body2: ReadableStream | null = null;
        if (response.body) {
            [body1, body2] = response.body.tee();
        }

        // Cache the response
        const meta = parseMeta(response);
        if (meta && meta.staleWhileRevalidate) {
            cache.set(cacheKey, body2, meta); //don't await
            res.appendHeader("X-Cache", "MISS");
        } else {
            //if null it's uncachable, if no swr header also don't cache
            res.appendHeader("X-Cache", "BYPASS");
        }

        // Send the response to the client
        response.headers.forEach((value, key) => {
            res.setHeader(key, value);
        });
        res.removeHeader("Accept-Ranges"); // we don't support that
        res.appendHeader("Via", "swr-cache-proxy");
        const isFresh = fresh(req.headers, {
            etag: response.headers.get("ETag") || undefined,
            "last-modified": response.headers.get("Last-Modified") || undefined,
        });

        if (isFresh) {
            res.removeHeader("Content-Type");
            res.removeHeader("Content-Length");
            res.removeHeader("Transfer-Encoding");
            res.statusCode = 304;
            res.end();
        } else {
            res.statusCode = response.status;
            if (body1) {
                Readable.fromWeb(body1).pipe(res, { end: true });
            } else {
                res.end();
            }
        }
    }
}
