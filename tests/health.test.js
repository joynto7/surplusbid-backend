"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const supertest_1 = __importDefault(require("supertest"));
const app_1 = __importDefault(require("../src/app"));
describe('GET /api/v1/health', () => {
    it('returns success envelope', async () => {
        const res = await (0, supertest_1.default)(app_1.default).get('/api/v1/health');
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });
});
//# sourceMappingURL=health.test.js.map