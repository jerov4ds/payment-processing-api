import { MemoryPaymentRepository } from "../../../src/adapters/persistence/memory-payment-repository";
import { paymentRepositoryContract } from "../../contract/payment-repository.contract";

paymentRepositoryContract("memory payment repository", async () => {
  const repo = new MemoryPaymentRepository();
  return {
    repo,
    cleanup: async () => {
      await repo.close();
    },
  };
});
