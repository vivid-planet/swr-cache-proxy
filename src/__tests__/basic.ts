import { ChildProcess, spawn } from "child_process";
import request from "supertest";

function timeout(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

let testOriginServer: ChildProcess | undefined;
let proxyServer: ChildProcess | undefined;

beforeAll(async () => {
    {
        console.log("starting test-origin process");
        testOriginServer = spawn("node", ["./dist/test/test-origin.js"], { stdio: "inherit" });

        testOriginServer.on("error", (err: unknown) => {
            console.error("Error starting test-origin server:", err);
        });

        testOriginServer.on("close", (code: number) => {
            testOriginServer = undefined;
            if (code) {
                throw new Error(`test-origin exited with code ${code}`);
            }
            console.log(`test-origin exited`);
        });
    }

    {
        console.log("starting proxy process");
        proxyServer = spawn("node", ["./dist/index.js"], { stdio: "inherit" });

        proxyServer.on("error", (err: unknown) => {
            console.error("Error starting proxy server:", err);
        });

        proxyServer.on("close", (code: number) => {
            proxyServer = undefined;
            if (code) {
                throw new Error(`proxy exited with code ${code}`);
            }
            console.log(`proxy exited`);
        });
    }

    await timeout(2000); // Wait for servers to start
});

afterAll(async () => {
    if (proxyServer && proxyServer.pid) {
        //process.kill(-proxyServer.pid, "SIGINT");
        console.log("killing proxyServer", proxyServer.pid);
        proxyServer.kill("SIGINT");
        while (proxyServer) {
            console.log("waiting for proxyServer to stop", proxyServer.exitCode);
            await timeout(100);
        }
    }

    if (testOriginServer && testOriginServer.pid) {
        //process.kill(-testOriginServer.pid, "SIGINT");
        testOriginServer.kill("SIGINT");
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
});
