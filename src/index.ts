import { Option, program } from "commander";
import http from "http";

import { FilesystemCacheBackend } from "./cache";
import { handleRequest } from "./handleRequest";

program
    .name("swr-cache-proxy")
    .addOption(new Option("--origin <origin>", "Origin server URL").env("ORIGIN_URL").makeOptionMandatory())
    .addOption(new Option("--port <port>", "port to listen on").default("3000").env("PORT"))
    .addOption(new Option("--cacheSizeLimitHint <megabytes>", "maximum cache size hint").default("500").env("CACHE_SIZE_LIMIT_HINT"))
    .addOption(new Option("--cacheDir <dir>", "directory cache files will be written into").default("cache").env("CACHE_DIR"))
    .action(({ port, cacheDir, cacheSizeLimitHint, origin }: { port: string; cacheDir: string; cacheSizeLimitHint: string; origin: string }) => {
        // Ensure the cache directory exists
        const cache = new FilesystemCacheBackend(cacheDir, parseInt(cacheSizeLimitHint) * 1024 * 1024);

        console.log(`Starting proxy server for origin ${origin}`);
        http.createServer(function (req, res) {
            try {
                handleRequest(req, res, { origin, cache });
            } catch (err) {
                console.error(err);
                res.write("Internal Server Error");
                res.statusCode = 500;
                res.end();
            }
        }).listen(port, () => {
            console.log(`Proxy server is running on port ${port}`);
        });
    })
    .parse();
