import express from "express";

const app = express();
const port = parseInt(process.argv[2]);
if (!port) {
    console.error("no port specified, pass as first argument");
    process.exit(1);
}

app.all("/hello", async (req, res) => {
    res.send("hello");
});

let count = 0;
app.all("/count", async (req, res) => {
    res.appendHeader("Cache-Control", "max-age=1, stale-while-revalidate=2");
    res.send(String(count++));
});

app.get("/ifmodified", async (req, res) => {
    res.appendHeader("Cache-Control", "max-age=1, stale-while-revalidate=2");
    res.appendHeader("Last-Modified", new Date("2023-09-09 09:09:09 GMT").toUTCString());
    res.send("foo");
});

app.get("/via", async (req, res) => {
    res.appendHeader("Via", "foo");
    res.send("foo");
});

app.all("/long", async (req, res) => {
    res.appendHeader("Cache-Control", "max-age=60, stale-while-revalidate=120");
    res.send("long");
});
app.all("/long2", async (req, res) => {
    res.appendHeader("Cache-Control", "max-age=60, stale-while-revalidate=120");
    res.send("long2");
});

app.get("/no-swr", async (req, res) => {
    res.appendHeader("Cache-Control", "max-age=100");
    res.send(String(count++));
});

app.listen(port, () => {
    console.log(`test origin server is running on port ${port}`);
});
