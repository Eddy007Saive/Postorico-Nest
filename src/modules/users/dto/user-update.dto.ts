import { IsBoolean, IsOptional, IsString } from 'class-validator';

/** Port direct de backend/models/user.py::UserUpdate. */
export class UserUpdateDto {
  @IsOptional() @IsString() nom?: string;
  @IsOptional() @IsString() username?: string;

  // Voix de marque (nourrit les agents du Studio IA)
  @IsOptional() @IsString() secteur?: string;
  @IsOptional() @IsString() voix_marque?: string;
  @IsOptional() @IsString() audience?: string;
  @IsOptional() @IsString() piliers?: string;
  @IsOptional() @IsString() a_eviter?: string;
  @IsOptional() @IsString() hooks?: string;
  @IsOptional() @IsString() ctas?: string;
  @IsOptional() @IsString() regles?: string;

  // Exemples de posts par réseau (few-shot : calibre le style)
  @IsOptional() @IsString() exemples_linkedin?: string;
  @IsOptional() @IsString() exemples_instagram?: string;
  @IsOptional() @IsString() exemples_facebook?: string;
  @IsOptional() @IsString() exemples_tiktok?: string;
  @IsOptional() @IsString() exemples_googlebusiness?: string;
  @IsOptional() @IsString() exemples_twitter?: string;

  @IsOptional() @IsString() photo_url?: string;
  @IsOptional() @IsBoolean() use_photo?: boolean;
  @IsOptional() @IsBoolean() use_inspirations?: boolean;
  @IsOptional() @IsString() user_name?: string;
  @IsOptional() @IsString() style_vestimentaire?: string;
  @IsOptional() @IsString() sexe?: string;

  @IsOptional() @IsString() couleur_principale?: string;
  @IsOptional() @IsString() couleur_secondaire?: string;
  @IsOptional() @IsString() couleur_accent?: string;
  @IsOptional() @IsString() style_image?: string;

  @IsOptional() @IsString() carrousel_couleur_principale?: string;
  @IsOptional() @IsString() carrousel_couleur_secondaire?: string;
  @IsOptional() @IsString() carrousel_couleur_accent?: string;
  @IsOptional() @IsString() carrousel_font?: string;
  @IsOptional() @IsString() carrousel_font_corps?: string;

  @IsOptional() @IsString() late_profile_id?: string;
  @IsOptional() @IsString() late_account_linkedin?: string;
  @IsOptional() @IsString() late_account_instagram?: string;
  @IsOptional() @IsString() late_account_facebook?: string;
  @IsOptional() @IsString() late_account_tiktok?: string;
  @IsOptional() @IsString() late_account_youtube?: string;
  @IsOptional() @IsString() late_account_googlebusiness?: string;
  @IsOptional() @IsString() late_account_twitter?: string;

  @IsOptional() @IsString() telegram_bot_token?: string;
  @IsOptional() @IsString() telegram_bot_username?: string;
  @IsOptional() @IsString() timezone?: string;
  @IsOptional() @IsString() langue?: string;
}
