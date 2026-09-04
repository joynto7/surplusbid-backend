import { redis } from '../src/config/redis';

afterAll(async () => {
  await redis.quit();
});
