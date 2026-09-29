import { LlmUsage } from '../../usage/interfaces/llm-usage.interface';

export interface RedigerPostResult {
  contenu: string;
  usage: LlmUsage;
}
