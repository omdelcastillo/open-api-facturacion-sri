import { Module, Global } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';

/**
 * Módulo global de colas con BullMQ + Redis.
 * Lee la conexión Redis desde la sección redis.* de configuration.ts
 * en vez de ENV vars directas para consistencia.
 * Opciones de cola parametrizables desde configuration.ts / ENV.
 */
@Global()
@Module({
  imports: [
    // Conexión a Redis usando sección centralizada de configuration.ts
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        connection: {
          host:     configService.getOrThrow<string>('redis.host'),
          port:     configService.getOrThrow<number>('redis.port'),
          password: configService.get<string>('redis.password') || undefined,
          db:       configService.getOrThrow<number>('redis.db'),
          maxRetriesPerRequest: null, // Requerido por BullMQ
        },
      }),
    }),

    // Cola de emisión SRI — opciones parametrizables desde ENV
    BullModule.registerQueueAsync({
      name: 'sri-emision',
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        defaultJobOptions: {
          attempts: configService.getOrThrow<number>('queues.sriEmision.attempts'),
          backoff: {
            type: 'exponential',
            delay: configService.getOrThrow<number>('queues.sriEmision.backoffDelayMs'),
          },
          removeOnComplete: {
            count: configService.getOrThrow<number>('queues.sriEmision.removeOnComplete'),
          },
          removeOnFail: {
            count: configService.getOrThrow<number>('queues.sriEmision.removeOnFail'),
          },
        },
      }),
    }),

    // Cola de webhook dispatch — opciones parametrizables desde ENV
    BullModule.registerQueueAsync({
      name: 'webhook-dispatch',
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        defaultJobOptions: {
          attempts: configService.getOrThrow<number>('queues.webhookDispatch.attempts'),
          backoff: {
            type: 'exponential',
            delay: configService.getOrThrow<number>('queues.webhookDispatch.backoffDelayMs'),
          },
          removeOnComplete: {
            count: configService.getOrThrow<number>('queues.webhookDispatch.removeOnComplete'),
          },
          removeOnFail: {
            count: configService.getOrThrow<number>('queues.webhookDispatch.removeOnFail'),
          },
        },
      }),
    }),

    // Cola de email dispatch — envío de RIDE por email tras autorización SRI
    BullModule.registerQueueAsync({
      name: 'email-dispatch',
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        defaultJobOptions: {
          attempts: configService.getOrThrow<number>('queues.emailDispatch.attempts'),
          backoff: {
            type: 'exponential',
            delay: configService.getOrThrow<number>('queues.emailDispatch.backoffDelayMs'),
          },
          removeOnComplete: {
            count: configService.getOrThrow<number>('queues.emailDispatch.removeOnComplete'),
          },
          removeOnFail: {
            count: configService.getOrThrow<number>('queues.emailDispatch.removeOnFail'),
          },
        },
      }),
    }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
