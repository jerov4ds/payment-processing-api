import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JsonFilePaymentRepository } from "../../../src/adapters/persistence/json-file-payment-repository";
import {
  StorageCorruptError,
  StorageUnavailableError,
} from "../../../src/domain/errors";
import { paymentRepositoryContract } from "../../contract/payment-repository.contract";
import { createMockLogger, samplePayment } from "../../helpers/fixtures";

paymentRepositoryContract("json file payment repository", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "payments-"));
  const filePath = path.join(directory, "payments.json");
  const repo = new JsonFilePaymentRepository(filePath, createMockLogger());
  await repo.init();
  return {
    repo,
    cleanup: async () => {
      await repo.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
});

describe("json file payment repository", () => {
  it("creates an empty store when the file is missing and reloads it", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "payments-missing-"),
    );
    const filePath = path.join(directory, "payments.json");
    const logger = createMockLogger();
    const repo = new JsonFilePaymentRepository(filePath, logger);
    await repo.init();
    expect(
      logger.entries.some((entry) =>
        entry.msg?.includes("creating an empty file"),
      ),
    ).toBe(true);
    const payment = samplePayment();
    await repo.withTransaction(async (tx) => {
      await tx.insert(payment, {
        clientId: "demo",
        key: payment.idempotencyKey,
        requestHash: "hash",
        paymentId: payment.id,
        responseStatus: 202,
        responseBody: payment,
        createdAt: payment.createdAt,
      });
    });
    await repo.close();
    const reloaded = new JsonFilePaymentRepository(
      filePath,
      createMockLogger(),
    );
    await reloaded.init();
    expect(await reloaded.findById(payment.id)).toEqual(payment);
    const files = await readdir(directory);
    expect(files.filter((file) => file.endsWith(".tmp"))).toEqual([]);
    await rm(directory, { recursive: true, force: true });
  });

  it("refuses to start when the file is corrupt and leaves the bytes alone", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "payments-corrupt-"),
    );
    const filePath = path.join(directory, "payments.json");
    await writeFile(filePath, "{ not json", "utf8");
    const logger = createMockLogger();
    const repo = new JsonFilePaymentRepository(filePath, logger);
    await expect(repo.init()).rejects.toBeInstanceOf(StorageCorruptError);
    expect(await readFile(filePath, "utf8")).toBe("{ not json");
    expect(logger.entries.some((entry) => entry.level === "error")).toBe(true);
    await rm(directory, { recursive: true, force: true });
  });

  it("assigns a client from the idempotency record when an older file has none", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "payments-legacy-"));
    const filePath = path.join(directory, "payments.json");
    const legacy = samplePayment();
    const withoutClient: Partial<typeof legacy> = { ...legacy };
    delete withoutClient.clientId;
    await writeFile(
      filePath,
      JSON.stringify({
        schemaVersion: 1,
        payments: [withoutClient],
        idempotencyKeys: [
          {
            clientId: "demo",
            key: legacy.idempotencyKey,
            requestHash: "hash",
            paymentId: legacy.id,
            responseStatus: 202,
            responseBody: withoutClient,
            createdAt: legacy.createdAt,
          },
        ],
      }),
      "utf8",
    );
    const repo = new JsonFilePaymentRepository(filePath, createMockLogger());
    await repo.init();
    expect((await repo.findById(legacy.id))?.clientId).toBe("demo");
    await rm(directory, { recursive: true, force: true });
  });

  it("refuses to start when the parent directory does not exist", async () => {
    const filePath = path.join(
      os.tmpdir(),
      "payments-missing-dir",
      `${Date.now()}`,
      "payments.json",
    );
    const repo = new JsonFilePaymentRepository(filePath, createMockLogger());
    await expect(repo.init()).rejects.toBeInstanceOf(StorageUnavailableError);
  });

  it("refuses a schema-invalid document and leaves the bytes alone", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "payments-schema-"));
    const filePath = path.join(directory, "payments.json");
    const raw = JSON.stringify({
      schemaVersion: 2,
      payments: [],
      idempotencyKeys: [],
    });
    await writeFile(filePath, raw, "utf8");
    const repo = new JsonFilePaymentRepository(filePath, createMockLogger());
    await expect(repo.init()).rejects.toBeInstanceOf(StorageCorruptError);
    expect(await readFile(filePath, "utf8")).toBe(raw);
    expect(() => {
      void repo.findById(samplePayment().id);
    }).toThrow(StorageUnavailableError);
    await rm(directory, { recursive: true, force: true });
  });

  it("creates the store readable only by the owner and notices a deleted file", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "payments-mode-"));
    const filePath = path.join(directory, "payments.json");
    const repo = new JsonFilePaymentRepository(filePath, createMockLogger());
    await repo.init();
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);
    await unlink(filePath);
    await expect(repo.ping()).rejects.toBeInstanceOf(StorageUnavailableError);
    await rm(directory, { recursive: true, force: true });
  });

  it("keeps every concurrent insert of a distinct payment", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "payments-concurrent-"),
    );
    const filePath = path.join(directory, "payments.json");
    const repo = new JsonFilePaymentRepository(filePath, createMockLogger());
    await repo.init();
    await Promise.all(
      Array.from({ length: 20 }, (_, index) => {
        const payment = samplePayment({
          id: `3fa85f64-5717-4562-b3fc-2c963f66a${index.toString(16).padStart(3, "0")}`,
          idempotencyKey: `key-${index}-ok`,
        });
        return repo.withTransaction(async (tx) => {
          await tx.insert(payment, {
            clientId: "demo",
            key: payment.idempotencyKey,
            requestHash: "hash",
            paymentId: payment.id,
            responseStatus: 202,
            responseBody: payment,
            createdAt: payment.createdAt,
          });
        });
      }),
    );
    const page = await repo.list({ clientId: "demo", limit: 50, offset: 0 });
    expect(page.total).toBe(20);
    await rm(directory, { recursive: true, force: true });
  });

  it("writes a transaction to disk when it starts during another's write", async () => {
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "payments-staggered-"),
    );
    const filePath = path.join(directory, "payments.json");
    const repo = new JsonFilePaymentRepository(filePath, createMockLogger());
    await repo.init();
    const insertOne = (index: number): Promise<void> => {
      const payment = samplePayment({
        id: `3fa85f64-5717-4562-b3fc-2c963f66b${index.toString(16).padStart(3, "0")}`,
        idempotencyKey: `staggered-${index}`,
      });
      return repo.withTransaction(async (tx) => {
        await tx.insert(payment, {
          clientId: "demo",
          key: payment.idempotencyKey,
          requestHash: "hash",
          paymentId: payment.id,
          responseStatus: 202,
          responseBody: payment,
          createdAt: payment.createdAt,
        });
      });
    };
    const writes: Promise<void>[] = [];
    for (let index = 0; index < 5; index += 1) {
      writes.push(insertOne(index));
      await new Promise((resolve) => setImmediate(resolve));
    }
    await Promise.all(writes);
    const onDisk = JSON.parse(await readFile(filePath, "utf8")) as {
      payments: unknown[];
    };
    expect(onDisk.payments).toHaveLength(5);
    await repo.close();
    await rm(directory, { recursive: true, force: true });
  });
});
