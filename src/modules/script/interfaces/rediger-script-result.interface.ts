import { LlmUsage } from '../../usage/interfaces/llm-usage.interface';

export interface RedigerScriptResult {
  script: string;
  usage: LlmUsage;
}
