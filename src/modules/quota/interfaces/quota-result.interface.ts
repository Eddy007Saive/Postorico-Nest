export interface QuotaResult {
  ok: boolean;
  reason?: string;
  message?: string;
  action_type: string;
  qty: number;
  subscription_id?: string;
  unit_cost?: number;
  used?: number;
  limit?: number;
}
