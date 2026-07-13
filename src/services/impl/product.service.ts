import {type Cradle} from '@fastify/awilix';
import {eq} from 'drizzle-orm';
import {type INotificationService} from '../notifications.port.js';
import {
	orders, products, type Order, type Product,
} from '@/db/schema.js';
import {type Database} from '@/db/type.js';

const MILLISECONDS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * Holds all the business rules that decide, for each product of an order,
 * whether the stock can be decremented or whether the customer must be
 * notified (delay, out of stock, expiration).
 */
export class ProductService {
	private readonly ns: INotificationService;
	private readonly db: Database;

	public constructor({ns, db}: Pick<Cradle, 'ns' | 'db'>) {
		this.ns = ns;
		this.db = db;
	}

	/**
	 * Loads an order with its products and applies the availability rules to
	 * each of them. Returns `undefined` when the order does not exist.
	 */
	public async processOrder(orderId: number): Promise<Order | undefined> {
		const order = await this.db.query.orders.findFirst({
			where: eq(orders.id, orderId),
			with: {
				products: {
					columns: {},
					with: {product: true},
				},
			},
		});

		if (!order) {
			return undefined;
		}

		for (const {product} of order.products) {
			await this.processProduct(product); // eslint-disable-line no-await-in-loop
		}

		return order;
	}

	/**
	 * Applies the availability rules of a single product according to its type.
	 */
	public async processProduct(product: Product): Promise<void> {
		switch (product.type) {
			case 'NORMAL': {
				await this.handleNormalProduct(product);
				break;
			}

			case 'SEASONAL': {
				await this.handleSeasonalProduct(product);
				break;
			}

			case 'EXPIRABLE': {
				await this.handleExpirableProduct(product);
				break;
			}

			default: {
				break;
			}
		}
	}

	/**
	 * Persists a new lead time and notifies the customer of the restocking delay.
	 */
	public async notifyDelay(leadTime: number, product: Product): Promise<void> {
		product.leadTime = leadTime;
		await this.save(product);
		this.ns.sendDelayNotification(leadTime, product.name);
	}

	/**
	 * NORMAL products have no particularity: sell while in stock, otherwise
	 * announce the restocking delay.
	 */
	private async handleNormalProduct(product: Product): Promise<void> {
		if (product.available > 0) {
			await this.decrementStock(product);
		} else if (product.leadTime > 0) {
			await this.notifyDelay(product.leadTime, product);
		}
	}

	/**
	 * SEASONAL products can only be sold within their season and while in stock.
	 */
	private async handleSeasonalProduct(product: Product): Promise<void> {
		const now = new Date();
		const sellable = product.available > 0
			&& now > product.seasonStartDate!
			&& now < product.seasonEndDate!;

		await (sellable
			? this.decrementStock(product)
			: this.handleUnavailableSeasonalProduct(product));
	}

	private async handleUnavailableSeasonalProduct(product: Product): Promise<void> {
		const now = new Date();
		const restockDate = new Date(now.getTime() + (product.leadTime * MILLISECONDS_PER_DAY));

		if (restockDate > product.seasonEndDate!) {
			// Restocking would happen after the season ends: the product cannot be delivered in time.
			this.ns.sendOutOfStockNotification(product.name);
			product.available = 0;
			await this.save(product);
		} else if (product.seasonStartDate! > now) {
			// The season has not started yet.
			this.ns.sendOutOfStockNotification(product.name);
			await this.save(product);
		} else {
			// In season but out of stock, and restocking happens before the season ends.
			await this.notifyDelay(product.leadTime, product);
		}
	}

	/**
	 * EXPIRABLE products can be sold while in stock and not yet expired.
	 */
	private async handleExpirableProduct(product: Product): Promise<void> {
		const now = new Date();

		if (product.available > 0 && product.expiryDate! > now) {
			await this.decrementStock(product);
		} else {
			this.ns.sendExpirationNotification(product.name, product.expiryDate!);
			product.available = 0;
			await this.save(product);
		}
	}

	private async decrementStock(product: Product): Promise<void> {
		product.available -= 1;
		await this.save(product);
	}

	private async save(product: Product): Promise<void> {
		await this.db.update(products).set(product).where(eq(products.id, product.id));
	}
}
