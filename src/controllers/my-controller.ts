import fastifyPlugin from 'fastify-plugin';
import {serializerCompiler, validatorCompiler, type ZodTypeProvider} from 'fastify-type-provider-zod';
import {z} from 'zod';

export const myController = fastifyPlugin(async server => {
	// Add schema validator and serializer
	server.setValidatorCompiler(validatorCompiler);
	server.setSerializerCompiler(serializerCompiler);

	server.withTypeProvider<ZodTypeProvider>().post('/orders/:orderId/processOrder', {
		schema: {
			params: z.object({
				orderId: z.coerce.number(),
			}),
		},
	}, async (request, reply) => {
		const productService = server.diContainer.resolve('ps');
		const order = await productService.processOrder(request.params.orderId);

		if (!order) {
			await reply.status(404).send({message: `Order ${request.params.orderId} not found`});
			return;
		}

		await reply.send({orderId: order.id});
	});
});
