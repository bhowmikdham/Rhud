import { Allow, IsIn, IsInt, IsString, Matches, Min } from 'class-validator';

// See engagements/dto.ts: seed fixtures use v0 UUIDs which @IsUUID() rejects.
// Production IDs from gen_random_uuid() are v4 and pass either way.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export class SubmitAnswerDto {
  @Matches(UUID_RE, { message: 'nodeId must be UUID-formatted' })
  nodeId!: string;

  // Answer is a JSON value (string | string[] | number | null) — the engine
  // validates shape per node type at the service layer with a precise reason.
  @Allow()
  answer!: unknown;
}

export class LoopStepDto {
  @Matches(UUID_RE, { message: 'loopId must be UUID-formatted' })
  loopId!: string;

  @IsIn(['continue', 'done'])
  action!: 'continue' | 'done';
}

export class CreateUploadUrlDto {
  @Matches(UUID_RE, { message: 'nodeId must be UUID-formatted' })
  nodeId!: string;

  @IsString()
  filename!: string;

  @IsString()
  contentType!: string;

  @IsInt()
  @Min(1)
  sizeBytes!: number;
}
