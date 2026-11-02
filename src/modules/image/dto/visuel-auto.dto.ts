import { IsUUID } from 'class-validator';

export class VisuelAutoDto {
  @IsUUID()
  contenu_id!: string;
}
