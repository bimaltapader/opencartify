
import {
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service.js';
import { UpdateStoreDto } from './dto/update-store.dto.js';

@Injectable()
export class StoresService {
  constructor(private readonly prisma: PrismaService) {}

  async getMyStore(userId: string) {
    const store = await this.prisma.store.findFirst({
      where: { ownerId: userId },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        logoUrl: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!store) {
      throw new NotFoundException('Store not found.');
    }

    return {
      message: 'Store retrieved successfully.',
      store,
    };
  }

  async updateMyStore(userId: string, data: UpdateStoreDto) {
    const store = await this.prisma.store.findFirst({
      where: { ownerId: userId },
      select: { id: true },
    });

    if (!store) {
      throw new NotFoundException('Store not found.');
    }

    const updatedStore = await this.prisma.store.update({
      where: { id: store.id },
      data,
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        logoUrl: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return {
      message: 'Store updated successfully.',
      store: updatedStore,
    };
  }
}
