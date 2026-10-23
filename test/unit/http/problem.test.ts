import {
  InvalidTransitionError,
  ValidationError,
} from "../../../src/domain/errors";
import { toProblem } from "../../../src/http/problem";

const context = {
  requestId: "req-1",
  instance: "/api/v1/payments",
  problemBaseUri: "https://payment-service.local/problems",
  exposeStack: false,
};

describe("problem details", () => {
  it("maps coded errors to stable status codes and hides stacks", () => {
    const problem = toProblem(
      new InvalidTransitionError("PROCESSING", "CANCELLED"),
      context,
    );
    expect(problem).toMatchObject({
      status: 409,
      code: "INVALID_TRANSITION",
      title: "Conflict",
      requestId: "req-1",
      type: "https://payment-service.local/problems/invalid-transition",
    });
    expect(problem.stack).toBeUndefined();
    expect(JSON.stringify(problem)).not.toContain("node_modules");
  });

  it("includes field errors and a stack only in development", () => {
    const error = new ValidationError("Request validation failed", {
      errors: [{ path: "amount", message: "Expected integer" }],
    });
    const hidden = toProblem(error, context);
    expect(hidden.status).toBe(400);
    expect(hidden.errors).toEqual([
      { path: "amount", message: "Expected integer" },
    ]);
    expect(hidden.stack).toBeUndefined();
    const exposed = toProblem(error, { ...context, exposeStack: true });
    expect(exposed.stack).toContain("ValidationError");
  });

  it("hides unexpected errors outside development and reveals them in development", () => {
    const failure = new Error("disk sector 7 secret");
    const hidden = toProblem(failure, context);
    expect(hidden).toMatchObject({ status: 500, code: "INTERNAL_ERROR" });
    expect(hidden.detail).toBe("An unexpected error occurred.");
    expect(JSON.stringify(hidden)).not.toContain("secret");
    const exposed = toProblem(failure, { ...context, exposeStack: true });
    expect(exposed.detail).toBe("disk sector 7 secret");
    expect(exposed.stack).toContain("disk sector 7 secret");
  });

  it("recognizes body-parser failures", () => {
    const tooLarge = Object.assign(new Error("too large"), {
      status: 413,
      type: "entity.too.large",
    });
    expect(toProblem(tooLarge, context).status).toBe(413);
    const invalid = Object.assign(new SyntaxError("Unexpected token"), {
      status: 400,
      type: "entity.parse.failed",
    });
    expect(toProblem(invalid, context)).toMatchObject({
      status: 400,
      code: "VALIDATION_ERROR",
      detail: "Request body is not valid JSON",
    });
  });
});
