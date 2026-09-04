"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const supertest_1 = __importDefault(require("supertest"));
const ApiError_1 = require("../src/utils/ApiError");
const asyncHandler_1 = require("../src/utils/asyncHandler");
const errorHandler_1 = require("../src/middleware/errorHandler");
const testApp = (0, express_1.default)();
testApp.get('/boom', (0, asyncHandler_1.asyncHandler)(async () => {
    throw new ApiError_1.ApiError(400, 'Bad input', ['field is required']);
}));
testApp.use(errorHandler_1.errorHandler);
describe('errorHandler', () => {
    it('converts ApiError into the standard error envelope', async () => {
        const res = await (0, supertest_1.default)(testApp).get('/boom');
        expect(res.status).toBe(400);
        expect(res.body).toEqual({ success: false, message: 'Bad input', errors: ['field is required'] });
    });
});
//# sourceMappingURL=errorHandler.test.js.map