import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { CUSTOMER_TYPES, PRICING_MODELS, SCOPE_UNITS, type CustomerType, type PricingModel, type ScopeUnit } from '@rhud/shared';

export class CreateTierDto {
  @IsInt()
  @Min(0)
  rangeMin!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  rangeMax?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  methodology?: string | null;

  @IsIn(CUSTOMER_TYPES as unknown as string[])
  customerType!: CustomerType;

  @IsInt()
  @Min(0)
  priceCents!: number;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  displayLabel?: string | null;
}

export class CreateServiceLineDto {
  @Matches(/^[a-z][a-z0-9_]{1,60}$/)
  slug!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  displayName!: string;

  @IsIn(SCOPE_UNITS as unknown as string[])
  scopeUnit!: ScopeUnit;

  @IsOptional()
  @IsIn(PRICING_MODELS as unknown as string[])
  pricingModel?: PricingModel;

  @IsOptional()
  @IsInt()
  position?: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateTierDto)
  tiers!: CreateTierDto[];
}

export class CreateOpenPricedDto {
  @Matches(/^[a-z][a-z0-9_]{1,60}$/)
  slug!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  displayName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  category?: string | null;
}

export class CreateRateCardDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @Matches(/^[A-Z]{3}$/)
  currency?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateServiceLineDto)
  serviceLines!: CreateServiceLineDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateOpenPricedDto)
  openPricedServices?: CreateOpenPricedDto[];
}

// Quote ----------------------------------------------------------------------

export class QuoteEntityDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  entityId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(80)
  serviceLineSlug!: string;

  @IsObject()
  dimensions!: Record<string, number>;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  methodology?: string | null;

  @IsIn(CUSTOMER_TYPES as unknown as string[])
  customerType!: CustomerType;
}

export class QuoteDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => QuoteEntityDto)
  scope!: QuoteEntityDto[];
}
