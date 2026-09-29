export interface CheckoutResult {
  ok: boolean;
  url?: string;
  error?: string;
}

export interface InvoiceItem {
  number: string | null;
  date: string | null;
  amount: number;
  currency: string;
  status: string | null | undefined;
  pdf: string | null;
  url: string | null;
}

export interface AdminInvoiceItem extends InvoiceItem {
  client: string;
  email: string | null | undefined;
  telegram_id: string | null;
}

export interface PackListItem {
  id: string;
  action_type: string;
  name: string;
  quantity: number;
  price_cents: number;
}

export interface AbonnementInfo {
  plan: string;
  prix_cents: number;
  statut: string | null;
  renouvelle_le: Date | null;
  resilie_le: Date | null;
  stripe_subscription_id: string | null;
}

export interface LienPackResult {
  ok: boolean;
  url?: string;
  devise?: string;
  expire_le?: number | null;
  error?: string;
}

export interface CarteEnregistreeResult {
  ok: boolean;
  carte?: { marque: string | null; fin: string | null; expire: string } | null;
  abonnement?: string | null;
  error?: string;
}

export interface DemarrerAbonnementResult {
  ok: boolean;
  status?: string;
  devise?: string;
  ecourte?: boolean;
  prochain_prelevement?: number | null;
  error?: string;
}

export interface SyncResult {
  ok: boolean;
  synced?: boolean;
  status?: string;
  error?: string;
}

export interface ResilierResult {
  ok: boolean;
  fin_acces_le?: Date | string | null;
  error?: string;
}

export interface PauseResult {
  ok: boolean;
  reprise_le?: string;
  mois?: number;
  error?: string;
}

export interface OuvrirParcoursResult {
  ok: boolean;
  id?: string | null;
}

export interface NotifyPayload {
  kind: string;
  nom: string | null;
  email: string | null | undefined;
  plan: string | null;
  extra?: string | null;
}

export interface ClientImpayePayload {
  nom: string | null;
  email: string;
  lien: string;
}

export interface FacturePayload {
  nom: string | null;
  email: string;
  montant: number;
  devise: string;
  libelle: string;
  numero?: string | null;
  url?: string | null;
  pdf?: string | null;
}

export interface RappelPayload {
  email: string;
  nom: string | null;
  montant: number;
  devise: string;
  date: string;
  apres_pack: boolean;
}

export interface WebhookResult {
  ok: boolean;
  event?: string;
  duplicate?: boolean;
  error?: string;
  canceled_uid?: string | null;
  notify?: NotifyPayload | null;
  client_impaye?: ClientImpayePayload | null;
  facture?: FacturePayload | null;
  rappel?: RappelPayload | null;
}
