import { IsIn } from 'class-validator';

export class SetAuditStatusDto {
  @IsIn(['nouveau', 'en_cours', 'traite'])
  status: string;
}