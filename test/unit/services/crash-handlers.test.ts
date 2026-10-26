import { EventEmitter } from "node:events";
import { installCrashHandlers } from "../../../src/services/crash-handlers";
import { createMockLogger } from "../../helpers/fixtures";

describe("crash handlers", () => {
  it("logs an uncaught exception as fatal and exits 1", () => {
    const target = new EventEmitter();
    const logger = createMockLogger();
    const exits: number[] = [];
    installCrashHandlers(target, logger, (code) => exits.push(code));
    const error = new Error("worker blew up");
    target.emit("uncaughtException", error);
    expect(exits).toEqual([1]);
    expect(logger.entries).toEqual([
      { level: "fatal", obj: { err: error }, msg: "uncaught exception" },
    ]);
  });

  it("logs an unhandled rejection as fatal and exits 1", () => {
    const target = new EventEmitter();
    const logger = createMockLogger();
    const exits: number[] = [];
    installCrashHandlers(target, logger, (code) => exits.push(code));
    target.emit("unhandledRejection", "storage went away");
    expect(exits).toEqual([1]);
    expect(logger.entries).toEqual([
      {
        level: "fatal",
        obj: { err: "storage went away" },
        msg: "unhandled promise rejection",
      },
    ]);
  });

  it("exits once when a second crash arrives during the first", () => {
    const target = new EventEmitter();
    const logger = createMockLogger();
    const exits: number[] = [];
    installCrashHandlers(target, logger, (code) => exits.push(code));
    target.emit("uncaughtException", new Error("first"));
    target.emit("unhandledRejection", new Error("second"));
    expect(exits).toEqual([1]);
    expect(logger.entries).toHaveLength(2);
  });
});
