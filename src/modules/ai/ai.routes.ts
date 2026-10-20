import { Router } from 'express';
import { authenticate } from '../../middleware/auth';
import { keyRateLimit } from '../../middleware/keyRateLimit';
import { optionalAuth } from '../../middleware/optionalAuth';
import { requireRole } from '../../middleware/rbac';
import { validate } from '../../middleware/validate';
import { chat, listing, recommendations, searchIntent, suggestions, trending } from './ai.controller';
import { chatSchema, searchIntentSchema } from './ai.validation';
import { listingAssistSchema } from './listing';

const router = Router();

router.post(
  '/chat',
  optionalAuth,
  keyRateLimit('ai-chat', 20, 10 * 60, 'The assistant needs a short break. Please try again in a few minutes.'),
  validate(chatSchema),
  chat
);
router.get('/suggest', keyRateLimit('ai-suggest', 240, 60, 'Too many requests, slow down'), suggestions);
router.post(
  '/search-intent',
  keyRateLimit('ai-intent', 60, 10 * 60, 'Too many searches. Please wait a moment.'),
  validate(searchIntentSchema),
  searchIntent
);
router.get('/recommendations', optionalAuth, recommendations);
router.get('/trending', trending);
router.post(
  '/listing-assist',
  authenticate,
  requireRole('SELLER'),
  keyRateLimit('ai-listing', 30, 60 * 60, 'You have drafted many listings this hour. Please try again later.'),
  validate(listingAssistSchema),
  listing
);

export default router;
