import httpMocks from "node-mocks-http";

import { normalizedAcceptEncoding } from "./handleRequest";

describe("normalizedAcceptEncoding", () => {
    it("should return undefined if no accept-encoding header", () => {
        const req = httpMocks.createRequest({ url: "/foo" });
        expect(normalizedAcceptEncoding(req)).toBeUndefined();
    });
    it("should return gzip if only gzip is passed", () => {
        const req = httpMocks.createRequest({ url: "/foo", headers: { "accept-encoding": "gzip" } });
        expect(normalizedAcceptEncoding(req)).toBe("gzip");
    });
    it("should return br if gzip, br is passed", () => {
        const req = httpMocks.createRequest({ url: "/foo", headers: { "accept-encoding": "gzip, br" } });
        expect(normalizedAcceptEncoding(req)).toBe("br");
    });
    it("should return undefined if url ends with .jpg", () => {
        const req = httpMocks.createRequest({ url: "/foo.jpg", headers: { "accept-encoding": "gzip, br" } });
        expect(normalizedAcceptEncoding(req)).toBeUndefined();
    });
});
