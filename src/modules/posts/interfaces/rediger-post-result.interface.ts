import { LlmUsage } from '../../usage/interfaces/llm-usage.interface';

export interface RedigerPostResult {
  contenu: string;
  usage: LlmUsage;
  /** Formule d'accroche retenue (null si l'IA ne l'a pas indiquée). */
  formule_accroche?: number | null;
  /** Nombres de la première ligne absents des infos du client (chiffre peut-être inventé). */
  accroche_chiffres_non_sources?: string[];
}
