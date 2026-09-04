import Stripe from 'stripe';
import { env } from './env';

// Pinned to a known-stable Stripe API version rather than the SDK's bundled
// "latest" (currently a newer dated version). Stripe's own StripeConfig types
// only reflect that latest version, so the cast is required to pin an older,
// still-supported account API version — see https://stripe.com/docs/api/versioning.
export const stripe = new Stripe(env.stripeSecretKey, {
  apiVersion: '2024-06-20' as Stripe.LatestApiVersion,
});
