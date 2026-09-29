import { IsBoolean, IsObject, IsOptional, IsString } from 'class-validator';

/** Body souple (comme Python, qui accepte un `dict` brut) : seuls les champs connus
 * de `offers` sont retenus par OffersService.clean(). */
export class OfferBodyDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  type?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  price?: string;

  @IsOptional()
  @IsString()
  benefits?: string;

  @IsOptional()
  @IsString()
  url?: string;

  @IsOptional()
  @IsObject()
  facts?: Record<string, unknown>;

  @IsOptional()
  @IsBoolean()
  actif?: boolean;
}
