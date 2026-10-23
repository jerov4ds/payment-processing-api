import { createHash } from "node:crypto";
import { ConfigError } from "../../../src/domain/errors";
import { loadEnv } from "../../../src/config/env";

describe("loadEnv", () => {
  const valid = { API_KEYS: "demo:dev-api-key-change-me" };

  it("applies defaults and hashes API secrets", () => {
    const env = loadEnv(valid);
    expect(env.port).toBe(4317);
    expect(env.repositoryDriver).toBe("json");
    expect(env.gatewayTransientFailureRate).toBe(0);
    expect(env.apiClients).toHaveLength(1);
    expect(env.apiClients[0]?.clientId).toBe("demo");
    expect(env.apiClients[0]?.secretHash).toEqual(
      createHash("sha256").update("dev-api-key-change-me").digest(),
    );
  });

  it("parses multiple keys, colon-bearing secrets, and CORS origins", () => {
    const env = loadEnv({
      API_KEYS: "demo:dev-api-key-change-me, merchant:sekret:with:colon",
      CORS_ORIGINS: " https://merchant.example, https://ops.example ",
      REPOSITORY_DRIVER: "memory",
    });
    expect(env.apiClients.map((client) => client.clientId)).toEqual([
      "demo",
      "merchant",
    ]);
    expect(env.corsOrigins).toEqual([
      "https://merchant.example",
      "https://ops.example",
    ]);
  });

  it("fails fast on missing keys, bad numbers, and inconsistent gateway settings", () => {
    expect(() => loadEnv({})).toThrow(ConfigError);
    expect(() => loadEnv({ API_KEYS: "demo:short" })).toThrow(/at least 8/);
    expect(() => loadEnv({ API_KEYS: "bad id:dev-api-key-change-me" })).toThrow(
      /client id/,
    );
    expect(() =>
      loadEnv({ API_KEYS: "demo:dev-api-key-change-me,demo:another-secret" }),
    ).toThrow(/Duplicate/);
    expect(() => loadEnv({ API_KEYS: "noseparator" })).toThrow(
      /clientId:secret/,
    );
    expect(() => loadEnv({ ...valid, PORT: "70000" })).toThrow(/PORT/);
    expect(() =>
      loadEnv({
        ...valid,
        GATEWAY_MIN_LATENCY_MS: "80",
        GATEWAY_MAX_LATENCY_MS: "10",
      }),
    ).toThrow(/GATEWAY_MIN_LATENCY_MS/);
    expect(() =>
      loadEnv({
        ...valid,
        GATEWAY_TRANSIENT_FAILURE_RATE: "0.8",
        GATEWAY_PERMANENT_FAILURE_RATE: "0.4",
      }),
    ).toThrow(/failure rates/);
    expect(() => loadEnv({ ...valid, REPOSITORY_DRIVER: "postgres" })).toThrow(
      /DATABASE_URL/,
    );
    expect(() =>
      loadEnv({
        ...valid,
        RETRY_BASE_DELAY_MS: "5000",
        RETRY_MAX_DELAY_MS: "10",
      }),
    ).toThrow(/RETRY_BASE_DELAY_MS/);
  });

  it("treats empty strings as unset so defaults still apply", () => {
    const env = loadEnv({ ...valid, PORT: "", CORS_ORIGINS: "" });
    expect(env.port).toBe(4317);
    expect(env.corsOrigins).toEqual([]);
  });
});
