import { ChildProcess, spawn } from "child_process";
import fs from "fs-extra";
import request from "supertest";

function timeout(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

let testOriginServer: ChildProcess | undefined;
let proxyServer: ChildProcess | undefined;

beforeEach(async () => {
    {
        testOriginServer = spawn("node", ["./dist/test/test-origin.js"], { stdio: "inherit" });

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

        proxyServer = spawn("node", ["./dist/index.js", "--port", "3000", "http://localhost:3001"], { stdio: "inherit" });

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

    await timeout(2000); // Wait for servers to start
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
        const res = await request("http://localhost:3000").get("/hello");
        expect(res.status).toBe(200);
        expect(res.text).toBe("hello");
    });
    it("origin count endpoint counts", async () => {
        {
            // first request
            const res = await request("http://localhost:3001").get("/count");
            expect(res.status).toBe(200);
            expect(res.text).toBe("0");
        }
        await timeout(100);
        {
            // second request
            const res = await request("http://localhost:3001").get("/count");
            expect(res.status).toBe(200);
            expect(res.text).toBe("1");
        }
    });
    it("count requests should cache", async () => {
        {
            // first request
            const res = await request("http://localhost:3000").get("/count");
            expect(res.status).toBe(200);
            expect(res.text).toBe("0");
            expect(res.header["x-cache"]).toBe("MISS");
        }
        await timeout(100);
        {
            // second request
            const res = await request("http://localhost:3000").get("/count");
            expect(res.status).toBe(200);
            expect(res.text).toBe("0");
            expect(res.header["x-cache"]).toBe("HIT");
        }
    });

    it("count requests should refresh cache after max-age", async () => {
        ///count does have max-age=1, stale-while-revalidate=2
        {
            // first request
            const res = await request("http://localhost:3000").get("/count");
            expect(res.status).toBe(200);
            expect(res.text).toBe("0");
            expect(res.header["x-cache"]).toBe("MISS");
        }
        await timeout(1000);
        {
            // second request, triggers revalidate in background and gets stale response
            const res = await request("http://localhost:3000").get("/count");
            expect(res.status).toBe(200);
            expect(res.text).toBe("0");
            expect(res.header["x-cache"]).toBe("HIT, REVALIDATE");
        }
        await timeout(100);
        {
            // third request, revalidation happend in background, gets fresh response
            const res = await request("http://localhost:3000").get("/count");
            expect(res.status).toBe(200);
            expect(res.text).toBe("1");
            expect(res.header["x-cache"]).toBe("HIT");
        }
        await timeout(100);
        {
            // still cached
            const res = await request("http://localhost:3000").get("/count");
            expect(res.status).toBe(200);
            expect(res.text).toBe("1");
            expect(res.header["x-cache"]).toBe("HIT");
        }
    });

    it("count requests should refresh cache after max-age", async () => {
        ///count does have max-age=1, stale-while-revalidate=2
        {
            // first request
            const res = await request("http://localhost:3000").get("/count");
            expect(res.status).toBe(200);
            expect(res.text).toBe("0");
            expect(res.header["x-cache"]).toBe("MISS");
        }
        await timeout(2000);
        {
            // second request, doesn't revalidate as too old, fetch sync
            const res = await request("http://localhost:3000").get("/count");
            expect(res.status).toBe(200);
            expect(res.text).toBe("1");
            expect(res.header["x-cache"]).toBe("MISS");
        }
        await timeout(100);
        {
            // still cached
            const res = await request("http://localhost:3000").get("/count");
            expect(res.status).toBe(200);
            expect(res.text).toBe("1");
            expect(res.header["x-cache"]).toBe("HIT");
        }
    });
});
