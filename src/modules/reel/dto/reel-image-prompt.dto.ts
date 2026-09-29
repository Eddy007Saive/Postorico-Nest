import { IsString } from 'class-validator';

export class ReelImagePromptDto {
  @IsString()
  brief!: string;
}
