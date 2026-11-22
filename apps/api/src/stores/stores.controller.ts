
import {
  Body,
  Controller,
  Get,
  Patch,
  Req,
  UseGuards,
} from '@nestjs/common';

import { StoresService } from './stores.service.js';
import { UpdateStoreDto } from './dto/update-store.dto.js';

import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { UserRole } from '../generated/prisma/client.js';

interface AuthenticatedRequest {
  user: {
    sub: string;
    role: string;
  };
}

@Controller('stores')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.VENDOR)
export class StoresController {
  constructor(private readonly storesService: StoresService) {}

  @Get('me')
  getMyStore(@Req() request: AuthenticatedRequest) {
    return this.storesService.getMyStore(request.user.sub);
  }

  @Patch('me')
  updateMyStore(
    @Req() request: AuthenticatedRequest,
    @Body() updateStoreDto: UpdateStoreDto,
  ) {
    return this.storesService.updateMyStore(
      request.user.sub,
      updateStoreDto,
    );
  }
}
