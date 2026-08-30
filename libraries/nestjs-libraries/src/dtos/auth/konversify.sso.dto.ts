import { IsDefined, IsString } from 'class-validator';

export class KonversifySsoDto {
  @IsString()
  @IsDefined()
  token: string;
}
