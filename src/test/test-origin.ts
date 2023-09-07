import express from "express";

const app = express();
const port = 3001;

app.all("/hello", async (req, res) => {
    res.send("hello");
});

app.listen(port, () => {
    console.log(`test origin server is running on port ${port}`);
});
