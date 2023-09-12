import { program } from "commander";
import http from "http";

import { FilesystemCacheBackend } from "./cache";
import { handleRequest } from "./handleRequest";

program
    .name("swr-cache-proxy")
    .argument("<origin>", "Origin server URL")
    .option("--port <port>", "port to listen on", "3000")
    .option("--cacheSizeLimitHint <megabytes>", "maximum cache size hint", "500")
    .option("--cacheDir <dir>", "directory cache files will be written into", "cache")
    .action((origin: string, { port, cacheDir, cacheSizeLimitHint }: { port: string; cacheDir: string; cacheSizeLimitHint: string }) => {
        // Ensure the cache directory exists
        const cache = new FilesystemCacheBackend(cacheDir, parseInt(cacheSizeLimitHint) * 1024 * 1024);

        console.log(`Starting proxy Server`);
        http.createServer(function (req, res) {
            return handleRequest(req, res, { origin, cache });
        }).listen(port, () => {
            console.log(`Proxy server is running on port ${port}`);
        });
    })
    .parse();
