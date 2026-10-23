import { Pool } from "pg";
import { PostgresPaymentRepository } from "../../../src/adapters/persistence/postgres-payment-repository";
import { applyMigrations } from "../../../src/adapters/persistence/migrate";
import { paymentRepositoryContract } from "../../contract/payment-repository.contract";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  it("runs the postgres contract when DATABASE_URL is set", () => {
    if (process.env.CI === "true") {
      throw new Error("DATABASE_URL is required when CI=true");
    }
  });
} else {
  describe("postgres payment repository", () => {
    let pool: Pool;

    beforeAll(async () => {
      pool = new Pool({ connectionString: databaseUrl });
      await applyMigrations(pool);
    });

    afterAll(async () => {
      await pool.end();
    });

    paymentRepositoryContract("postgres", async () => {
      await pool.query("TRUNCATE TABLE payments CASCADE");
      return {
        repo: new PostgresPaymentRepository(pool),
        cleanup: async () => {
          await pool.query("TRUNCATE TABLE payments CASCADE");
        },
      };
    });
  });
}
