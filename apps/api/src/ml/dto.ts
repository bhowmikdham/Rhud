import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

export class TrainRecordDto {
  @IsObject()
  scopeFields!: Record<string, unknown>;

  /** Dollars (e.g. 102000.50). Internally converted to cents by the ML service. */
  @IsNumber()
  @Min(0)
  finalPrice!: number;

  /**
   * Deterministic base price (dollars) at the time the deal closed. Required
   * for the modifier model — when every record carries this, the ML service
   * trains on log(final / base) instead of log(final).
   */
  @IsOptional()
  @IsNumber()
  @Min(0)
  basePrice?: number;

  @IsOptional()
  @IsString()
  serviceLine?: string;

  @IsOptional()
  @IsString()
  closedAt?: string;

  @IsOptional()
  @IsBoolean()
  wonLost?: boolean;
}

export class TrainDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TrainRecordDto)
  records!: TrainRecordDto[];
}
