import { BadRequestException, NotFoundException } from '@nestjs/common';

import {
  CartStatus,
  ProductStatus,
  StoreStatus,
} from '../generated/prisma/client.js';
import { CartService } from './cart.service.js';

const customerId = 'customer-1';
const otherCustomerId = 'customer-2';
const productId = 'product-1';
const cartId = 'cart-1';
const itemId = 'item-1';

describe('CartService', () => {
  let prisma: Record<string, any>;
  let transaction: Record<string, any>;
  let service: CartService;

  const validProduct = {
    id: productId,
    name: 'Sample Product',
    slug: 'sample-product',
    sku: 'SKU-SAMPLE',
    price: 100,
    compareAtPrice: 120,
    status: ProductStatus.ACTIVE,
    isPublished: true,
    deletedAt: null,
    store: {
      id: 'store-1',
      name: 'Sample Store',
      slug: 'sample-store',
      status: StoreStatus.ACTIVE,
    },
    images: [{ imageUrl: 'https://example.test/img.png', altText: 'Sample' }],
    inventory: {
      quantity: 10,
      reserved: 2, // available = 8
      lowStockThreshold: 3,
    },
  };

  const activeCart = {
    id: cartId,
    customerId,
    status: CartStatus.ACTIVE,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    transaction = {
      $queryRaw: vi.fn(),
      product: {
        findFirst: vi.fn(),
      },
      cartItem: {
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        upsert: vi.fn(),
        update: vi.fn(),
      },
    };

    prisma = {
      cart: {
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        create: vi.fn(),
      },
      cartItem: {
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        deleteMany: vi.fn(),
      },
      product: {
        findFirst: vi.fn(),
      },
      inventory: {
        update: vi.fn(), // to ensure cart operations never touch inventory directly
      },
      $transaction: vi.fn(async (callback: (tx: any) => Promise<any>) => {
        return callback(transaction);
      }),
    };

    service = new CartService(prisma as never);
  });

  describe('getOrCreateActiveCart', () => {
    it('returns existing active cart if found', async () => {
      prisma.cart.findFirst.mockResolvedValue(activeCart);

      const result = await service.getOrCreateActiveCart(customerId);

      expect(prisma.cart.findFirst).toHaveBeenCalledWith({
        where: { customerId, status: CartStatus.ACTIVE },
      });
      expect(prisma.cart.create).not.toHaveBeenCalled();
      expect(result).toEqual(activeCart);
    });

    it('creates and returns a new active cart if none exists', async () => {
      prisma.cart.findFirst.mockResolvedValue(null);
      prisma.cart.create.mockResolvedValue(activeCart);

      const result = await service.getOrCreateActiveCart(customerId);

      expect(prisma.cart.create).toHaveBeenCalledWith({
        data: { customerId, status: CartStatus.ACTIVE },
      });
      expect(result).toEqual(activeCart);
    });

    it('recovers specifically from P2002 collision and returns concurrent cart', async () => {
      prisma.cart.findFirst
        .mockResolvedValueOnce(null) // first check
        .mockResolvedValueOnce(activeCart); // fallback check after P2002 collision

      const p2002Error = new Error('Unique constraint failed') as any;
      p2002Error.code = 'P2002';
      prisma.cart.create.mockRejectedValue(p2002Error);

      const result = await service.getOrCreateActiveCart(customerId);

      expect(result).toEqual(activeCart);
    });

    it('propagates non-P2002 database errors without masking them', async () => {
      prisma.cart.findFirst.mockResolvedValue(null);

      const dbError = new Error('Database connection failed') as any;
      dbError.code = 'P1001';
      prisma.cart.create.mockRejectedValue(dbError);

      await expect(service.getOrCreateActiveCart(customerId)).rejects.toThrow(
        'Database connection failed',
      );
    });
  });

  describe('getCart', () => {
    it('retrieves active cart with enriched prices, available stock and totals', async () => {
      prisma.cart.findFirst.mockResolvedValue(activeCart);
      prisma.cart.findUnique.mockResolvedValue({
        ...activeCart,
        items: [
          {
            id: itemId,
            cartId,
            productId,
            quantity: 2,
            createdAt: new Date(),
            updatedAt: new Date(),
            product: validProduct,
          },
        ],
      });

      const result = await service.getCart(customerId);

      expect(result.cart.id).toBe(cartId);
      expect(result.cart.items).toHaveLength(1);
      const item = result.cart.items[0];
      expect(item.availableStock).toBe(8); // 10 - 2
      expect(item.hasSufficientStock).toBe(true);
      expect(item.isAvailable).toBe(true);
      expect(item.unitPrice).toBe(100);
      expect(item.itemTotal).toBe(200);
      expect(result.cart.summary).toEqual({
        totalItems: 1,
        totalQuantity: 2,
        subtotal: 200,
        hasUnavailableItems: false,
      });
    });

    it('flags unavailable and deleted products in cart', async () => {
      prisma.cart.findFirst.mockResolvedValue(activeCart);
      prisma.cart.findUnique.mockResolvedValue({
        ...activeCart,
        items: [
          {
            id: itemId,
            cartId,
            productId,
            quantity: 3,
            createdAt: new Date(),
            updatedAt: new Date(),
            product: {
              ...validProduct,
              deletedAt: new Date(),
            },
          },
        ],
      });

      const result = await service.getCart(customerId);

      expect(result.cart.items[0].isAvailable).toBe(false);
      expect(result.cart.items[0].warning).toBe(
        'Product is no longer available.',
      );
      expect(result.cart.summary.hasUnavailableItems).toBe(true);
      expect(result.cart.summary.subtotal).toBe(0);
    });

    it('flags inactive store in cart', async () => {
      prisma.cart.findFirst.mockResolvedValue(activeCart);
      prisma.cart.findUnique.mockResolvedValue({
        ...activeCart,
        items: [
          {
            id: itemId,
            cartId,
            productId,
            quantity: 2,
            createdAt: new Date(),
            updatedAt: new Date(),
            product: {
              ...validProduct,
              store: { ...validProduct.store, status: StoreStatus.SUSPENDED },
            },
          },
        ],
      });

      const result = await service.getCart(customerId);

      expect(result.cart.items[0].isAvailable).toBe(false);
      expect(result.cart.items[0].warning).toBe('Store is currently inactive.');
      expect(result.cart.summary.hasUnavailableItems).toBe(true);
    });

    it('flags insufficient stock when cart quantity exceeds available stock', async () => {
      prisma.cart.findFirst.mockResolvedValue(activeCart);
      prisma.cart.findUnique.mockResolvedValue({
        ...activeCart,
        items: [
          {
            id: itemId,
            cartId,
            productId,
            quantity: 9, // available is 8
            createdAt: new Date(),
            updatedAt: new Date(),
            product: validProduct,
          },
        ],
      });

      const result = await service.getCart(customerId);

      expect(result.cart.items[0].hasSufficientStock).toBe(false);
      expect(result.cart.items[0].warning).toBe('Only 8 units available.');
      expect(result.cart.summary.hasUnavailableItems).toBe(true);
    });

    it('handles empty cart cleanly', async () => {
      prisma.cart.findFirst.mockResolvedValue(activeCart);
      prisma.cart.findUnique.mockResolvedValue({
        ...activeCart,
        items: [],
      });

      const result = await service.getCart(customerId);

      expect(result.cart.items).toHaveLength(0);
      expect(result.cart.summary).toEqual({
        totalItems: 0,
        totalQuantity: 0,
        subtotal: 0,
        hasUnavailableItems: false,
      });
    });
  });

  describe('addItem', () => {
    it('rejects invalid quantities', async () => {
      await expect(
        service.addItem(customerId, { productId, quantity: 0 }),
      ).rejects.toBeInstanceOf(BadRequestException);

      await expect(
        service.addItem(customerId, { productId, quantity: -2 }),
      ).rejects.toBeInstanceOf(BadRequestException);

      await expect(
        service.addItem(customerId, { productId, quantity: 1.5 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects nonexistent product', async () => {
      prisma.cart.findFirst.mockResolvedValue(activeCart);
      transaction.product.findFirst.mockResolvedValue(null);

      await expect(
        service.addItem(customerId, { productId, quantity: 1 }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects draft or unpublished product', async () => {
      prisma.cart.findFirst.mockResolvedValue(activeCart);
      transaction.product.findFirst.mockResolvedValue({
        ...validProduct,
        isPublished: false,
      });

      await expect(
        service.addItem(customerId, { productId, quantity: 1 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects product from inactive store', async () => {
      prisma.cart.findFirst.mockResolvedValue(activeCart);
      transaction.product.findFirst.mockResolvedValue({
        ...validProduct,
        store: { ...validProduct.store, status: StoreStatus.CLOSED },
      });

      await expect(
        service.addItem(customerId, { productId, quantity: 1 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects out of stock product (available stock <= 0)', async () => {
      prisma.cart.findFirst.mockResolvedValue(activeCart);
      transaction.product.findFirst.mockResolvedValue({
        ...validProduct,
        inventory: { quantity: 5, reserved: 5 }, // available = 0
      });

      await expect(
        service.addItem(customerId, { productId, quantity: 1 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects requested quantity exceeding available stock', async () => {
      prisma.cart.findFirst.mockResolvedValue(activeCart);
      transaction.product.findFirst.mockResolvedValue(validProduct); // available = 8
      transaction.cartItem.findUnique.mockResolvedValue(null);

      await expect(
        service.addItem(customerId, { productId, quantity: 9 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('adds new item when product is not yet in cart with Cart row lock', async () => {
      prisma.cart.findFirst.mockResolvedValue(activeCart);
      transaction.product.findFirst.mockResolvedValue(validProduct);
      transaction.cartItem.findUnique.mockResolvedValue(null);
      transaction.cartItem.upsert.mockResolvedValue({
        id: itemId,
        cartId,
        productId,
        quantity: 3,
        product: {
          id: productId,
          name: 'Sample Product',
          sku: 'SKU-SAMPLE',
          price: 100,
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await service.addItem(customerId, {
        productId,
        quantity: 3,
      });

      expect(transaction.$queryRaw).toHaveBeenCalled();
      expect(transaction.cartItem.upsert).toHaveBeenCalledWith({
        where: {
          cartId_productId: { cartId, productId },
        },
        create: { cartId, productId, quantity: 3 },
        update: { quantity: 3 },
        include: { product: expect.any(Object) },
      });
      expect(result.item.quantity).toBe(3);
      expect(result.item.itemTotal).toBe(300);
      expect(prisma.inventory.update).not.toHaveBeenCalled(); // confirms no stock reservation
    });

    it('safely handles duplicate item by incrementing quantity under lock', async () => {
      prisma.cart.findFirst.mockResolvedValue(activeCart);
      transaction.product.findFirst.mockResolvedValue(validProduct); // available = 8
      transaction.cartItem.findUnique.mockResolvedValue({
        id: itemId,
        cartId,
        productId,
        quantity: 2,
      });
      transaction.cartItem.upsert.mockResolvedValue({
        id: itemId,
        cartId,
        productId,
        quantity: 5, // 2 + 3 = 5 <= 8
        product: {
          id: productId,
          name: 'Sample Product',
          sku: 'SKU-SAMPLE',
          price: 100,
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await service.addItem(customerId, {
        productId,
        quantity: 3,
      });

      expect(transaction.$queryRaw).toHaveBeenCalled();
      expect(transaction.cartItem.upsert).toHaveBeenCalledWith({
        where: {
          cartId_productId: { cartId, productId },
        },
        create: { cartId, productId, quantity: 3 },
        update: { quantity: 5 },
        include: { product: expect.any(Object) },
      });
      expect(result.item.quantity).toBe(5);
    });

    it('rejects increment if combined quantity exceeds available stock', async () => {
      prisma.cart.findFirst.mockResolvedValue(activeCart);
      transaction.product.findFirst.mockResolvedValue(validProduct); // available = 8
      transaction.cartItem.findUnique.mockResolvedValue({
        id: itemId,
        cartId,
        productId,
        quantity: 6,
      });

      await expect(
        service.addItem(customerId, { productId, quantity: 3 }), // 6 + 3 = 9 > 8
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('updateItem', () => {
    it('enforces customer ownership isolation', async () => {
      transaction.cartItem.findFirst.mockResolvedValue(null);

      await expect(
        service.updateItem(otherCustomerId, itemId, { quantity: 2 }),
      ).rejects.toBeInstanceOf(NotFoundException);

      expect(transaction.cartItem.findFirst).toHaveBeenCalledWith({
        where: {
          id: itemId,
          cart: {
            customerId: otherCustomerId,
            status: CartStatus.ACTIVE,
          },
        },
        include: expect.any(Object),
      });
    });

    it('rejects invalid quantity', async () => {
      await expect(
        service.updateItem(customerId, itemId, { quantity: 0 }),
      ).rejects.toBeInstanceOf(BadRequestException);

      await expect(
        service.updateItem(customerId, itemId, { quantity: -1 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects update if product is no longer available', async () => {
      transaction.cartItem.findFirst.mockResolvedValue({
        id: itemId,
        cart: { id: cartId },
        product: {
          ...validProduct,
          deletedAt: new Date(),
        },
      });

      await expect(
        service.updateItem(customerId, itemId, { quantity: 2 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects update exceeding available stock', async () => {
      transaction.cartItem.findFirst.mockResolvedValue({
        id: itemId,
        cart: { id: cartId },
        product: validProduct, // available = 8
      });

      await expect(
        service.updateItem(customerId, itemId, { quantity: 10 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('successfully updates item quantity under Cart row lock', async () => {
      transaction.cartItem.findFirst.mockResolvedValue({
        id: itemId,
        cart: { id: cartId },
        product: validProduct,
      });
      transaction.cartItem.update.mockResolvedValue({
        id: itemId,
        cartId,
        productId,
        quantity: 4,
        product: {
          id: productId,
          name: 'Sample Product',
          sku: 'SKU-SAMPLE',
          price: 100,
        },
        updatedAt: new Date(),
      });

      const result = await service.updateItem(customerId, itemId, {
        quantity: 4,
      });

      expect(transaction.$queryRaw).toHaveBeenCalled();
      expect(transaction.cartItem.update).toHaveBeenCalledWith({
        where: { id: itemId },
        data: { quantity: 4 },
        include: expect.any(Object),
      });
      expect(result.item.quantity).toBe(4);
      expect(result.item.itemTotal).toBe(400);
    });
  });

  describe('removeItem', () => {
    it('enforces customer ownership isolation', async () => {
      prisma.cartItem.findFirst.mockResolvedValue(null);

      await expect(
        service.removeItem(otherCustomerId, itemId),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('successfully removes an item from customer active cart', async () => {
      prisma.cartItem.findFirst.mockResolvedValue({ id: itemId });
      prisma.cartItem.delete.mockResolvedValue({ id: itemId });

      const result = await service.removeItem(customerId, itemId);

      expect(prisma.cartItem.delete).toHaveBeenCalledWith({
        where: { id: itemId },
      });
      expect(result.itemId).toBe(itemId);
    });
  });

  describe('clearCart', () => {
    it('clears all items in customer active cart', async () => {
      prisma.cart.findFirst.mockResolvedValue(activeCart);
      prisma.cartItem.deleteMany.mockResolvedValue({ count: 3 });

      const result = await service.clearCart(customerId);

      expect(prisma.cartItem.deleteMany).toHaveBeenCalledWith({
        where: { cartId: activeCart.id },
      });
      expect(result.clearedCount).toBe(3);
    });

    it('handles customer having no active cart', async () => {
      prisma.cart.findFirst.mockResolvedValue(null);

      const result = await service.clearCart(customerId);

      expect(prisma.cartItem.deleteMany).not.toHaveBeenCalled();
      expect(result.clearedCount).toBe(0);
    });
  });
});
