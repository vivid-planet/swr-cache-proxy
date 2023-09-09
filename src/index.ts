import { program } from "commander";
import http from "http";

import { FilesystemCacheBackend } from "./cache";
import { handleRequest } from "./handleRequest";

program
    .name("swr-cache-proxy")
    .argument("<origin>", "Origin server URL")
    .option("--port <port>", "port to listen on", "3000")
    .option("--cacheDir <dir>", "directory cache files will be written into", "cache")
    .action((origin: string, { port, cacheDir }: { port: string; cacheDir: string }) => {
        // Ensure the cache directory exists
        const cache = new FilesystemCacheBackend(cacheDir);

        console.log(`Starting proxy Server`);
        http.createServer(function (req, res) {
            return handleRequest(req, res, { origin, cache });
        }).listen(port, () => {
            console.log(`Proxy server is running on port ${port}`);
        });
    })
    .parse();
