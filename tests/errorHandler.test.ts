import express from 'express';
import request from 'supertest';
import { ApiError } from '../src/utils/ApiError';
import { asyncHandler } from '../src/utils/asyncHandler';
import { errorHandler } from '../src/middleware/errorHandler';

const testApp = express();
testApp.get(
  '/boom',
  asyncHandler(async () => {
    throw new ApiError(400, 'Bad input', ['field is required']);
  })
);
testApp.use(errorHandler);

describe('errorHandler', () => {
  it('converts ApiError into the standard error envelope', async () => {
    const res = await request(testApp).get('/boom');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ success: false, message: 'Bad input', errors: ['field is required'] });
  });
});
