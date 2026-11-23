import { GUARDS_METADATA } from '@nestjs/common/constants';

import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { ROLES_KEY } from '../auth/roles.decorator.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { UserRole } from '../generated/prisma/client.js';
import { CartController } from './cart.controller.js';

describe('CartController', () => {
  const cartService = {
    getCart: vi.fn(),
    addItem: vi.fn(),
    updateItem: vi.fn(),
    removeItem: vi.fn(),
    clearCart: vi.fn(),
  };

  let controller: CartController;

  beforeEach(() => {
    vi.clearAllMocks();
    controller = new CartController(cartService as never);
  });

  it('requires authenticated customer role', () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, CartController)).toEqual([
      JwtAuthGuard,
      RolesGuard,
    ]);
    expect(Reflect.getMetadata(ROLES_KEY, CartController)).toEqual([
      UserRole.CUSTOMER,
    ]);
  });

  it('passes the authenticated customer to getCart', () => {
    const request = { user: { sub: 'customer-123', role: UserRole.CUSTOMER } };

    controller.getCart(request);

    expect(cartService.getCart).toHaveBeenCalledWith('customer-123');
  });

  it('passes customer and dto to addItem', () => {
    const request = { user: { sub: 'customer-123', role: UserRole.CUSTOMER } };
    const dto = { productId: 'prod-1', quantity: 2 };

    controller.addItem(request, dto);

    expect(cartService.addItem).toHaveBeenCalledWith('customer-123', dto);
  });

  it('passes customer, itemId, and dto to updateItem', () => {
    const request = { user: { sub: 'customer-123', role: UserRole.CUSTOMER } };
    const dto = { quantity: 5 };

    controller.updateItem(request, 'item-1', dto);

    expect(cartService.updateItem).toHaveBeenCalledWith(
      'customer-123',
      'item-1',
      dto,
    );
  });

  it('passes customer and itemId to removeItem', () => {
    const request = { user: { sub: 'customer-123', role: UserRole.CUSTOMER } };

    controller.removeItem(request, 'item-1');

    expect(cartService.removeItem).toHaveBeenCalledWith(
      'customer-123',
      'item-1',
    );
  });

  it('passes customer to clearCart', () => {
    const request = { user: { sub: 'customer-123', role: UserRole.CUSTOMER } };

    controller.clearCart(request);

    expect(cartService.clearCart).toHaveBeenCalledWith('customer-123');
  });
});
