import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

/** Bounds line up with HARD_MAX_PAGES in crawler.service.ts. */
export class CrawlOptionsDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5_000)
  maxPages?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(20)
  maxDepth?: number;

  /** Regex (string form). Validated for pattern length only — actual
   *  regex compilation is best-effort at crawl time so invalid regexes
   *  don't 400 the rep with a confusing message. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  includePathRegex?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  excludePathRegex?: string;

  /** Render with headless Chromium. Tighter budget defaults apply. */
  @IsOptional()
  @IsBoolean()
  useJsRendering?: boolean;
}

export class KickoffSiteEnumerationDto {
  /** Required. Accepts URLs with or without scheme — crawler normalises. */
  @IsString()
  @MaxLength(500)
  // Loose check — at least a host-like substring with a dot.
  @Matches(/.+\..+/, { message: 'siteUrl must look like a hostname or URL' })
  siteUrl!: string;

  @IsOptional()
  @Type(() => CrawlOptionsDto)
  options?: CrawlOptionsDto;
}

export class MapToRateCardDto {
  @IsString()
  rateCardId!: string;
}
