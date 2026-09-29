import { IsString } from 'class-validator';

export class MontageTranscrireDto {
  @IsString()
  element_id!: string;
}
