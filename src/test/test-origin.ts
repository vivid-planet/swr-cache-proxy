import express from "express";

const app = express();
const port = 3001;

app.all("/hello", async (req, res) => {
    res.send("hello");
});

let count = 0;
app.all("/count", async (req, res) => {
    res.send(String(count++));
});

app.listen(port, () => {
    console.log(`test origin server is running on port ${port}`);
});
