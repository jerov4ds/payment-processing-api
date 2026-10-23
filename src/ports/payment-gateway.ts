export interface ChargeCommand {
  paymentId: string;
  amount: number;
  currency: string;
  attempt: number;
  timeoutMs: number;
}

export interface PaymentGateway {
  charge(command: ChargeCommand): Promise<{ approved: true }>;
}
