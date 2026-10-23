import request from "supertest";
import { createTestApp } from "../helpers/app";

describe("payment desk", () => {
  it("serves an HTML console at the root", async () => {
    const { app } = await createTestApp();
    const response = await request(app).get("/");
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(/text\/html/);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.text).toContain("Payment desk");
    expect(response.text).toContain('id="charge-form"');
    expect(response.text).toContain("/api/v1/payments");
    expect(response.text).not.toContain("test-key-1");
    expect(response.text).not.toContain("dev-api-key-change-me");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["content-security-policy"]).toContain(
      "frame-ancestors 'none'",
    );
  });
});
