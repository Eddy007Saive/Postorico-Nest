import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class CheckoutDto {
  @IsOptional()
  @IsString()
  plan?: string;

  @IsOptional()
  @IsBoolean()
  essai?: boolean;
}
