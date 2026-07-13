import {
	describe, it, expect, beforeEach,
	afterEach,
} from 'vitest';
import {mockDeep, type DeepMockProxy} from 'vitest-mock-extended';
import {eq} from 'drizzle-orm';
import {type INotificationService} from '../notifications.port.js';
import {createDatabaseMock, cleanUp} from '../../utils/test-utils/database-tools.ts.js';
import {ProductService} from './product.service.js';
import {products, type Product} from '@/db/schema.js';
import {type Database} from '@/db/type.js';

const DAY = 24 * 60 * 60 * 1000;

describe('ProductService Tests', () => {
	let notificationServiceMock: DeepMockProxy<INotificationService>;
	let productService: ProductService;
	let databaseMock: Database;
	let databaseName: string;
	let closeDatabase: () => void;

	beforeEach(async () => {
		({databaseMock, databaseName, close: closeDatabase} = await createDatabaseMock());
		notificationServiceMock = mockDeep<INotificationService>();
		productService = new ProductService({
			ns: notificationServiceMock,
			db: databaseMock,
		});
	});

	afterEach(async () => {
		closeDatabase();
		await cleanUp(databaseName);
	});

	/**
	 * Inserts a fully-formed product, letting each test override only the
	 * fields relevant to the case it exercises.
	 */
	async function insertProduct(overrides: Partial<Product>): Promise<Product> {
		const product: Product = {
			id: 1,
			leadTime: 15,
			available: 30,
			type: 'NORMAL',
			name: 'A product',
			expiryDate: null,
			seasonStartDate: null,
			seasonEndDate: null,
			...overrides,
		};
		await databaseMock.insert(products).values(product);
		return product;
	}

	async function reload(id: number): Promise<Product | undefined> {
		return databaseMock.query.products.findFirst({
			where: eq(products.id, id),
		});
	}

	describe('notifyDelay', () => {
		it('should persist the lead time and notify the customer of the delay', async () => {
			// GIVEN
			const product = await insertProduct({
				leadTime: 15, available: 0, type: 'NORMAL', name: 'RJ45 Cable',
			});

			// WHEN
			await productService.notifyDelay(product.leadTime, product);

			// THEN
			expect(product.available).toBe(0);
			expect(product.leadTime).toBe(15);
			expect(notificationServiceMock.sendDelayNotification).toHaveBeenCalledWith(15, 'RJ45 Cable');
			expect(await reload(product.id)).toEqual(product);
		});
	});

	describe('NORMAL products', () => {
		it('should decrement the stock when the product is available', async () => {
			const product = await insertProduct({type: 'NORMAL', available: 30});

			await productService.processProduct(product);

			expect((await reload(product.id))!.available).toBe(29);
			expect(notificationServiceMock.sendDelayNotification).not.toHaveBeenCalled();
		});

		it('should notify a delay when out of stock and a lead time exists', async () => {
			const product = await insertProduct({
				type: 'NORMAL', available: 0, leadTime: 10, name: 'USB Dongle',
			});

			await productService.processProduct(product);

			expect((await reload(product.id))!.available).toBe(0);
			expect(notificationServiceMock.sendDelayNotification).toHaveBeenCalledWith(10, 'USB Dongle');
		});

		it('should do nothing when out of stock without a lead time', async () => {
			const product = await insertProduct({type: 'NORMAL', available: 0, leadTime: 0});

			await productService.processProduct(product);

			expect((await reload(product.id))!.available).toBe(0);
			expect(notificationServiceMock.sendDelayNotification).not.toHaveBeenCalled();
		});
	});

	describe('SEASONAL products', () => {
		it('should decrement the stock when in season and available', async () => {
			const product = await insertProduct({
				type: 'SEASONAL',
				available: 30,
				seasonStartDate: new Date(Date.now() - (2 * DAY)),
				seasonEndDate: new Date(Date.now() + (58 * DAY)),
			});

			await productService.processProduct(product);

			expect((await reload(product.id))!.available).toBe(29);
			expect(notificationServiceMock.sendOutOfStockNotification).not.toHaveBeenCalled();
		});

		it('should flag as out of stock when restocking would exceed the season end', async () => {
			const product = await insertProduct({
				type: 'SEASONAL',
				available: 0,
				leadTime: 15,
				name: 'Watermelon',
				seasonStartDate: new Date(Date.now() - (20 * DAY)),
				seasonEndDate: new Date(Date.now() + (5 * DAY)),
			});

			await productService.processProduct(product);

			expect(notificationServiceMock.sendOutOfStockNotification).toHaveBeenCalledWith('Watermelon');
			expect((await reload(product.id))!.available).toBe(0);
		});

		it('should notify out of stock when the season has not started yet', async () => {
			const product = await insertProduct({
				type: 'SEASONAL',
				available: 30,
				leadTime: 15,
				name: 'Grapes',
				seasonStartDate: new Date(Date.now() + (180 * DAY)),
				seasonEndDate: new Date(Date.now() + (240 * DAY)),
			});

			await productService.processProduct(product);

			expect(notificationServiceMock.sendOutOfStockNotification).toHaveBeenCalledWith('Grapes');
			// Stock is left untouched: the product is simply not sellable yet.
			expect((await reload(product.id))!.available).toBe(30);
		});

		it('should notify a delay when in season, out of stock, but restockable before the season ends', async () => {
			const product = await insertProduct({
				type: 'SEASONAL',
				available: 0,
				leadTime: 5,
				name: 'Strawberry',
				seasonStartDate: new Date(Date.now() - (10 * DAY)),
				seasonEndDate: new Date(Date.now() + (30 * DAY)),
			});

			await productService.processProduct(product);

			expect(notificationServiceMock.sendDelayNotification).toHaveBeenCalledWith(5, 'Strawberry');
			expect(notificationServiceMock.sendOutOfStockNotification).not.toHaveBeenCalled();
		});
	});

	describe('EXPIRABLE products', () => {
		it('should decrement the stock when available and not expired', async () => {
			const product = await insertProduct({
				type: 'EXPIRABLE',
				available: 30,
				name: 'Butter',
				expiryDate: new Date(Date.now() + (26 * DAY)),
			});

			await productService.processProduct(product);

			expect((await reload(product.id))!.available).toBe(29);
			expect(notificationServiceMock.sendExpirationNotification).not.toHaveBeenCalled();
		});

		it('should notify expiration and zero the stock when expired', async () => {
			const expiryDate = new Date(Date.now() - (2 * DAY));
			const product = await insertProduct({
				type: 'EXPIRABLE', available: 6, name: 'Milk', expiryDate,
			});

			await productService.processProduct(product);

			expect(notificationServiceMock.sendExpirationNotification).toHaveBeenCalledWith('Milk', expiryDate);
			expect((await reload(product.id))!.available).toBe(0);
		});

		it('should announce a delay when out of stock but not expired (behaves like a NORMAL product)', async () => {
			const expiryDate = new Date(Date.now() + (26 * DAY));
			const product = await insertProduct({
				type: 'EXPIRABLE', available: 0, leadTime: 12, name: 'Cheese', expiryDate,
			});

			await productService.processProduct(product);

			// Still fresh: the customer is told about the restocking delay, not a (false) expiration.
			expect(notificationServiceMock.sendDelayNotification).toHaveBeenCalledWith(12, 'Cheese');
			expect(notificationServiceMock.sendExpirationNotification).not.toHaveBeenCalled();
		});
	});
});
