import { IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString } from 'class-validator';

export class VideoCreateDto {
  @IsString()
  video_url!: string;

  @IsOptional()
  @IsString()
  titre?: string;

  @IsOptional()
  @IsString()
  template?: string;

  @IsOptional()
  @IsBoolean()
  brolls?: boolean;

  @IsOptional()
  @IsInt()
  broll_pct?: number;

  @IsOptional()
  @IsBoolean()
  zooms?: boolean;

  @IsOptional()
  @IsIn(['natural', 'fast', 'extra-fast'])
  silence_pace?: string;

  @IsOptional()
  @IsBoolean()
  clean_audio?: boolean;

  @IsOptional()
  @IsString()
  music?: string;

  @IsOptional()
  @IsNumber()
  music_volume?: number;

  @IsOptional()
  @IsString()
  hook?: string;

  @IsOptional()
  @IsBoolean()
  hook_auto?: boolean;

  @IsOptional()
  @IsIn(['top', 'center', 'bottom'])
  hook_position?: string;

  @IsOptional()
  @IsNumber()
  hook_fontscale?: number;

  @IsOptional()
  @IsBoolean()
  emojis?: boolean;

  @IsOptional()
  @IsString()
  font?: string;

  @IsOptional()
  @IsString()
  hl_color?: string;

  @IsOptional()
  @IsNumber()
  fontscale?: number;

  @IsOptional()
  @IsNumber()
  position?: number;

  @IsOptional()
  @IsBoolean()
  uppercase?: boolean;

  @IsOptional()
  @IsArray()
  broll_urls?: string[];

  @IsOptional()
  @IsString()
  contenu_id?: string;

  @IsOptional()
  @IsString()
  raw_public_id?: string;

  @IsOptional()
  @IsArray()
  reseaux?: string[];

  @IsOptional()
  @IsString()
  reseau?: string;
}
