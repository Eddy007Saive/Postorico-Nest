import { IsString } from 'class-validator';

export class MontageVoixOffDto {
  @IsString()
  texte!: string;

  @IsString()
  voix!: string;
}
