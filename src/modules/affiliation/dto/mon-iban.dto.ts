import { IsOptional, IsString } from 'class-validator';

export class MonIbanDto {
  @IsOptional()
  @IsString()
  iban?: string;
}
