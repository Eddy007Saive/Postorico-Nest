import { IsOptional, IsString } from 'class-validator';

export class ReplyAuditDto {
  @IsOptional()
  @IsString()
  subject?: string;

  @IsString()
  message: string;
}