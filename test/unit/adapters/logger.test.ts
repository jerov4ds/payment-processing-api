import { createLogger } from "../../../src/adapters/logging/logger";

describe("logger redaction", () => {
  it("redacts API keys, tokens, and card fields", () => {
    const lines: string[] = [];
    const logger = createLogger("info", {
      write(chunk: string) {
        lines.push(chunk);
      },
    });
    logger.info(
      {
        req: {
          headers: {
            "x-api-key": "super-secret-value",
            authorization: "Bearer abc",
          },
          body: { paymentMethod: { token: "tok_secret_token" } },
        },
        paymentMethod: { token: "tok_other" },
        cvv: "123",
        pan: "4242424242424242",
      },
      "request",
    );
    const text = lines.join("");
    expect(text).not.toContain("super-secret-value");
    expect(text).not.toContain("Bearer abc");
    expect(text).not.toContain("tok_secret_token");
    expect(text).not.toContain("tok_other");
    expect(text).not.toContain("4242424242424242");
    expect(text).toContain("[Redacted]");
  });
});
