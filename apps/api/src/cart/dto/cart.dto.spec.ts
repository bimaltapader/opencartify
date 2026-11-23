import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { AddCartItemDto } from './add-cart-item.dto.js';
import { UpdateCartItemDto } from './update-cart-item.dto.js';

describe('Cart DTO validation', () => {
  async function validationErrors(instance: object) {
    return validate(instance);
  }

  describe('AddCartItemDto', () => {
    const validProductId = '11111111-1111-4111-8111-111111111111';

    it('accepts valid input', async () => {
      const dto = plainToInstance(AddCartItemDto, {
        productId: validProductId,
        quantity: 2,
      });

      const errors = await validationErrors(dto);
      expect(errors).toHaveLength(0);
    });

    it('rejects a missing productId', async () => {
      const dto = plainToInstance(AddCartItemDto, {
        quantity: 1,
      });

      const errors = await validationErrors(dto);
      expect(errors.some((e) => e.property === 'productId')).toBe(true);
    });

    it('rejects a non-UUID productId', async () => {
      const dto = plainToInstance(AddCartItemDto, {
        productId: 'not-a-uuid',
        quantity: 1,
      });

      const errors = await validationErrors(dto);
      expect(errors.some((e) => e.property === 'productId')).toBe(true);
    });

    it('rejects zero quantity', async () => {
      const dto = plainToInstance(AddCartItemDto, {
        productId: validProductId,
        quantity: 0,
      });

      const errors = await validationErrors(dto);
      expect(errors.some((e) => e.property === 'quantity')).toBe(true);
    });

    it('rejects negative quantity', async () => {
      const dto = plainToInstance(AddCartItemDto, {
        productId: validProductId,
        quantity: -5,
      });

      const errors = await validationErrors(dto);
      expect(errors.some((e) => e.property === 'quantity')).toBe(true);
    });

    it('rejects non-integer quantity', async () => {
      const dto = plainToInstance(AddCartItemDto, {
        productId: validProductId,
        quantity: 2.5,
      });

      const errors = await validationErrors(dto);
      expect(errors.some((e) => e.property === 'quantity')).toBe(true);
    });
  });

  describe('UpdateCartItemDto', () => {
    it('accepts valid quantity', async () => {
      const dto = plainToInstance(UpdateCartItemDto, {
        quantity: 5,
      });

      const errors = await validationErrors(dto);
      expect(errors).toHaveLength(0);
    });

    it('rejects zero quantity', async () => {
      const dto = plainToInstance(UpdateCartItemDto, {
        quantity: 0,
      });

      const errors = await validationErrors(dto);
      expect(errors.some((e) => e.property === 'quantity')).toBe(true);
    });

    it('rejects negative quantity', async () => {
      const dto = plainToInstance(UpdateCartItemDto, {
        quantity: -1,
      });

      const errors = await validationErrors(dto);
      expect(errors.some((e) => e.property === 'quantity')).toBe(true);
    });

    it('rejects non-integer quantity', async () => {
      const dto = plainToInstance(UpdateCartItemDto, {
        quantity: 3.14,
      });

      const errors = await validationErrors(dto);
      expect(errors.some((e) => e.property === 'quantity')).toBe(true);
    });
  });
});
