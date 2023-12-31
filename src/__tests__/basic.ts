import { ChildProcess, spawn } from "child_process";
import fs from "fs-extra";
import { getPorts as getPortsNonPromise, PortFinderOptions } from "portfinder";
import request from "supertest";
import waitOn from "wait-on";

function timeout(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function getPorts(count: number, options: PortFinderOptions = {}): Promise<number[]> {
    return new Promise(function (resolve, reject) {
        getPortsNonPromise(count, options, function (err, ports) {
            if (err) {
                return reject(err);
            }
            resolve(ports);
        });
    });
}

let testOriginServer: ChildProcess | undefined;
let proxyServer: ChildProcess | undefined;
let testOriginServerPort: number | undefined;
let proxyServerPort: number | undefined;

beforeEach(async () => {
    {
        [testOriginServerPort, proxyServerPort] = await getPorts(2);
        testOriginServer = spawn("node", ["./dist/test/test-origin.js", String(testOriginServerPort)], { stdio: "inherit" });

        testOriginServer.on("error", (err: unknown) => {
            console.error("Error starting test-origin server:", err);
        });

        testOriginServer.on("close", (code: number) => {
            testOriginServer = undefined;
            if (code) {
                throw new Error(`test-origin exited with code ${code}`);
            }
        });
    }

    {
        await fs.emptyDir("cache");

        proxyServer = spawn("node", ["./dist/index.js", "--port", String(proxyServerPort), "--origin", `http://localhost:${testOriginServerPort}`], {
            stdio: "inherit",
        });

        proxyServer.on("error", (err: unknown) => {
            console.error("Error starting proxy server:", err);
        });

        proxyServer.on("close", (code: number) => {
            proxyServer = undefined;
            if (code) {
                throw new Error(`proxy exited with code ${code}`);
            }
        });
    }

    await waitOn({ resources: [`tcp:localhost:${proxyServerPort}`, `tcp:localhost:${testOriginServerPort}`] });
});

afterEach(async () => {
    if (proxyServer && proxyServer.pid) {
        //process.kill(-proxyServer.pid, "SIGINT");
        proxyServer.kill("SIGINT");
        await timeout(100);
        while (proxyServer) {
            console.log("waiting for proxyServer to stop", proxyServer.exitCode);
            await timeout(100);
        }
    }

    if (testOriginServer && testOriginServer.pid) {
        //process.kill(-testOriginServer.pid, "SIGINT");
        testOriginServer.kill("SIGINT");
        await timeout(100);
        while (testOriginServer) {
            console.log("waiting for testOriginServer to stop");
            await timeout(100);
        }
    }
});

describe("Proxy Server E2E Tests", () => {
    it("should forward GET requests to target server", async () => {
        const res = await request(`http://localhost:${proxyServerPort}`).get("/hello");
        expect(res.status).toBe(200);
        expect(res.text).toBe("hello");
    });
    it("origin count endpoint counts", async () => {
        {
            // first request
            const res = await request(`http://localhost:${testOriginServerPort}`).get("/count");
            expect(res.status).toBe(200);
            expect(res.text).toBe("0");
        }
        await timeout(100);
        {
            // second request
            const res = await request(`http://localhost:${testOriginServerPort}`).get("/count");
            expect(res.status).toBe(200);
            expect(res.text).toBe("1");
        }
    });
    it("count requests should cache", async () => {
        {
            // first request
            const res = await request(`http://localhost:${proxyServerPort}`).get("/count");
            expect(res.status).toBe(200);
            expect(res.text).toBe("0");
            expect(res.header["x-cache"]).toBe("MISS");
        }
        await timeout(100);
        {
            // second request
            const res = await request(`http://localhost:${proxyServerPort}`).get("/count");
            expect(res.status).toBe(200);
            expect(res.text).toBe("0");
            expect(res.header["x-cache"]).toBe("HIT");
        }
    });

    it("count requests should refresh cache after max-age", async () => {
        ///count does have max-age=1, stale-while-revalidate=2
        {
            // first request
            const res = await request(`http://localhost:${proxyServerPort}`).get("/count");
            expect(res.status).toBe(200);
            expect(res.text).toBe("0");
            expect(res.header["x-cache"]).toBe("MISS");
        }
        await timeout(1100);
        {
            // second request, triggers revalidate in background and gets stale response
            const res = await request(`http://localhost:${proxyServerPort}`).get("/count");
            expect(res.status).toBe(200);
            expect(res.text).toBe("0");
            expect(res.header["x-cache"]).toBe("HIT");
            expect(res.header["x-age"]).toContain("revalidate");
        }
        await timeout(100);
        {
            // third request, revalidation happend in background, gets fresh response
            const res = await request(`http://localhost:${proxyServerPort}`).get("/count");
            expect(res.status).toBe(200);
            expect(res.text).toBe("1");
            expect(res.header["x-cache"]).toBe("HIT");
            expect(res.header["x-age"]).not.toContain("revalidate");
        }
        await timeout(100);
        {
            // still cached
            const res = await request(`http://localhost:${proxyServerPort}`).get("/count");
            expect(res.status).toBe(200);
            expect(res.text).toBe("1");
            expect(res.header["x-cache"]).toBe("HIT");
        }
    });

    it("count requests should miss cache after stale-while-revalidate", async () => {
        ///count does have max-age=1, stale-while-revalidate=2
        {
            // first request
            const res = await request(`http://localhost:${proxyServerPort}`).get("/count");
            expect(res.status).toBe(200);
            expect(res.text).toBe("0");
            expect(res.header["x-cache"]).toBe("MISS");
        }
        await timeout(2100);
        {
            // second request, doesn't revalidate as too old, fetch sync
            const res = await request(`http://localhost:${proxyServerPort}`).get("/count");
            expect(res.status).toBe(200);
            expect(res.text).toBe("1");
            expect(res.header["x-cache"]).toBe("MISS");
        }
        await timeout(100);
        {
            // still cached
            const res = await request(`http://localhost:${proxyServerPort}`).get("/count");
            expect(res.status).toBe(200);
            expect(res.text).toBe("1");
            expect(res.header["x-cache"]).toBe("HIT");
        }
    });

    it("404 should not cache", async () => {
        {
            const res = await request(`http://localhost:${proxyServerPort}`).get("/invalid");
            expect(res.status).toBe(404);
            expect(res.header["x-cache"]).toBe("BYPASS");
        }
    });

    it("HEAD request should work and cache for cached response", async () => {
        {
            const res = await request(`http://localhost:${proxyServerPort}`).head("/count");
            expect(res.status).toBe(200);
            expect(res.header["x-cache"]).toBe("MISS");
            expect(res.text).toBe(undefined);
        }
        await timeout(100);
        {
            const res = await request(`http://localhost:${proxyServerPort}`).head("/count");
            expect(res.status).toBe(200);
            expect(res.header["x-cache"]).toBe("HIT");
            expect(res.text).toBe(undefined);
        }
    });

    it("HEAD request should work for uncached response", async () => {
        {
            const res = await request(`http://localhost:${proxyServerPort}`).head("/hello");
            expect(res.status).toBe(200);
            expect(res.header["x-cache"]).toBe("BYPASS");
            expect(res.text).toBe(undefined);
        }
    });

    it("OPTIONS request should work and cache", async () => {
        {
            const res = await request(`http://localhost:${proxyServerPort}`).options("/count");
            expect(res.status).toBe(200);
            expect(res.header["x-cache"]).toBe("MISS");
        }
        await timeout(100);
        {
            const res = await request(`http://localhost:${proxyServerPort}`).options("/count");
            expect(res.status).toBe(200);
            expect(res.header["x-cache"]).toBe("HIT");
        }
    });

    it("POST request should work and not cache", async () => {
        {
            const res = await request(`http://localhost:${proxyServerPort}`).post("/count");
            expect(res.status).toBe(200);
            expect(res.text).toBe("0");
            expect(res.header["x-cache"]).toBe("BYPASS");
        }
        await timeout(100);
        {
            const res = await request(`http://localhost:${proxyServerPort}`).post("/count");
            expect(res.status).toBe(200);
            expect(res.text).toBe("1");
            expect(res.header["x-cache"]).toBe("BYPASS");
        }
    });

    it("if-modified-since should work correclty", async () => {
        let lastModified: string | undefined = undefined;
        {
            // first request
            const res = await request(`http://localhost:${proxyServerPort}`).get("/ifmodified");
            expect(res.status).toBe(200);
            expect(res.text).toBe("foo");
            expect(res.header["x-cache"]).toBe("MISS");
            expect(res.header["last-modified"]).toBeDefined();
            lastModified = res.header["last-modified"] as string;
        }
        await timeout(100);
        {
            // second request with if-modified-since should return 304 not modified
            const res = await request(`http://localhost:${proxyServerPort}`).get("/ifmodified").set("If-Modified-Since", lastModified);
            expect(res.status).toBe(304);
            expect(res.text).toBe("");
            expect(res.header["x-cache"]).toBe("HIT");
        }
        await timeout(2000);
        {
            // request with if-modified-since should return 304 not modified
            const res = await request(`http://localhost:${proxyServerPort}`).get("/ifmodified").set("If-Modified-Since", lastModified);
            expect(res.status).toBe(304);
            expect(res.text).toBe("");
            expect(res.header["x-cache"]).toBe("MISS");
        }
    });

    it("if-none-match should work correclty", async () => {
        let etag: string | undefined = undefined;
        {
            // first request
            const res = await request(`http://localhost:${proxyServerPort}`).get("/ifmodified");
            expect(res.status).toBe(200);
            expect(res.text).toBe("foo");
            expect(res.header["x-cache"]).toBe("MISS");
            expect(res.header["etag"]).toBeDefined();
            etag = res.header["etag"] as string;
        }
        await timeout(100);
        {
            // second request with if-none-match should return 304 not modified
            const res = await request(`http://localhost:${proxyServerPort}`).get("/ifmodified").set("If-None-Match", etag);
            expect(res.status).toBe(304);
            expect(res.text).toBe("");
            expect(res.header["x-cache"]).toBe("HIT");
        }
        await timeout(2000);
        {
            // request with if-none-match should return 304 not modified
            const res = await request(`http://localhost:${proxyServerPort}`).get("/ifmodified").set("If-None-Match", etag);
            expect(res.status).toBe(304);
            expect(res.text).toBe("");
            expect(res.header["x-cache"]).toBe("MISS");
        }
    });

    it("via header is set", async () => {
        const res = await request(`http://localhost:${proxyServerPort}`).get("/hello");
        expect(res.status).toBe(200);
        expect(res.header["via"]).toBe("swr-cache-proxy");
    });

    it("via header is appended to existing one from origin", async () => {
        const res = await request(`http://localhost:${proxyServerPort}`).get("/via");
        expect(res.status).toBe(200);
        expect(res.header["via"]).toBe("foo, swr-cache-proxy");
    });

    it("liveness probe should work", async () => {
        const res = await request(`http://localhost:${proxyServerPort}`).get("/.well-known/liveness");
        expect(res.status).toBe(200);
        expect(res.text).toBe("OK");
    });

    it("cacheable with max-age but without stale-while-revalidate should not cache", async () => {
        {
            const res = await request(`http://localhost:${proxyServerPort}`).get("/no-swr");
            expect(res.status).toBe(200);
            expect(res.text).toBe("0");
            expect(res.header["x-cache"]).toBe("BYPASS");
        }
        await timeout(100);
        {
            const res = await request(`http://localhost:${proxyServerPort}`).get("/no-swr");
            expect(res.status).toBe(200);
            expect(res.text).toBe("1");
            expect(res.header["x-cache"]).toBe("BYPASS");
        }
    });
});
