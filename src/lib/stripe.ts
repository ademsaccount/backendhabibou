import Stripe from 'stripe';
import { env } from '../config/env';

let stripe: Stripe | null = null;

if (env.STRIPE_SECRET_KEY) {
  stripe = new Stripe(env.STRIPE_SECRET_KEY, { typescript: true });
}

export const stripeEnabled = () => stripe !== null;

export async function createPaymentIntent(orderId: string, amount: number): Promise<string | null> {
  if (!stripe) return null;
  const intent = await stripe.paymentIntents.create({
    amount: Math.round(amount * 100),
    currency: env.STRIPE_CURRENCY,
    metadata: { order_id: orderId },
    automatic_payment_methods: { enabled: true },
  });
  return intent.client_secret;
}
