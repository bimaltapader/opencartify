import { GUARDS_METADATA } from '@nestjs/common/constants';

import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { ROLES_KEY } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { UserRole } from '../generated/prisma/client.js';
import { InventoryController } from './inventory.controller.js';

describe('InventoryController', () => {
  const inventoryService = {
    getMyInventory: vi.fn(),
    getMovements: vi.fn(),
    adjustInventory: vi.fn(),
  };

  let controller: InventoryController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new InventoryController(inventoryService as never);
  });

  it('requires authenticated vendors', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, InventoryController)).toEqual([
      JwtAuthGuard,
      RolesGuard,
    ]);
    expect(Reflect.getMetadata(ROLES_KEY, InventoryController)).toEqual([
      UserRole.VENDOR,
    ]);
  });

  it('passes the authenticated vendor to the inventory service', () => {
    const request = { user: { sub: 'vendor-id', role: UserRole.VENDOR } };

    controller.getMyInventory(request);

    expect(inventoryService.getMyInventory).toHaveBeenCalledWith('vendor-id');
  });

  it('passes pagination and adjustment requests to the service', () => {
    const request = { user: { sub: 'vendor-id', role: UserRole.VENDOR } };
    const query = { page: 2, limit: 10 };
    const dto = { quantityChange: -2, reason: 'Damaged item' };

    controller.getMovements(request, 'product-id', query);
    controller.adjustInventory(request, 'product-id', dto);

    expect(inventoryService.getMovements).toHaveBeenCalledWith(
      'vendor-id',
      'product-id',
      query,
    );
    expect(inventoryService.adjustInventory).toHaveBeenCalledWith(
      'vendor-id',
      'product-id',
      dto,
    );
  });
});
