import { program } from "commander";
import express from "express";

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

        const app = express();

        app.all("*", (req, res) => {
            return handleRequest(req, res, { origin, cache });
        });

        console.log(`Starting proxy Server`);
        app.listen(port, () => {
            console.log(`Proxy server is running on port ${port}`);
        });
    })
    .parse();
