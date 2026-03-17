import Stripe from "stripe";

type StripeInstance = InstanceType<typeof Stripe>;

let _stripe: StripeInstance | undefined;

// Lazy proxy — defers instantiation until first use so process.env is populated
export const stripe = new Proxy({} as StripeInstance, {
  get(_, prop: string | symbol) {
    if (!_stripe) {
      _stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
        apiVersion: "2023-10-16",
        httpClient: Stripe.createFetchHttpClient(),
      });
    }
    return Reflect.get(_stripe, prop);
  },
});
