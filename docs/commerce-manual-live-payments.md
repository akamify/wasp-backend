# Manual API keys and Partner OAuth

Manual Razorpay API keys and Partner OAuth remain independent authentication modes. Merchant credentials are connected from the workspace panel, encrypted, and resolved by workspace, gateway and test/live environment. They are not stored in the shared server .env.

## Manual merchant setup

1. Select the intended workspace and Live environment in Ecommerce Settings.
2. Enter that merchant's live Key ID and Key Secret, then connect. The backend probes the credentials before saving them.
3. Generate the webhook secret. Copy the displayed URL, secret and event subscriptions into the same merchant's Razorpay dashboard in Live mode. Saving the panel dialog does not create the webhook in Razorpay.
4. Enable workspace live checkout. Platform COMMERCE_GATEWAY_ENABLED, COMMERCE_PAYMENTS_ENABLED, COMMERCE_CHECKOUT_ENABLED and COMMERCE_LIVE_CHECKOUT_ENABLED, required indexes and payment recovery workers must also be configured.
5. Create a reviewed order's hosted Payment Link. Manual API-key connections no longer need OAuth identity proof or a previously received webhook to create the first live hosted link. A configured webhook secret is still mandatory. The application cannot know whether the merchant saved that secret in Razorpay until an event is processed.
6. Complete payment and verify the order status. The backend fetches provider resources with this gateway's credentials and checks capture, amount, currency and link/order correlation. The recovery worker can reconcile a payment if its webhook is delayed. A signed event alone never marks an order paid.

Webhook health starts as needs_setup and changes to verified only after signed-event/resource verification. API-key connections retain identityVerified=false unless separate account-ID evidence is established. Do not fabricate a merchantAccountId from a user-supplied value or signed payload: the merchant also knows the webhook secret. OAuth account-ID proof remains an optional native-payment setup mechanism, not a requirement for manual hosted checkout.

Partner OAuth connections retain their existing authorization and live verification requirements. Native WhatsApp payments retain verified account identity, verified webhook, Meta configuration and explicit native eligibility gates. Enabling manual hosted payments does not enable native WhatsApp payment UI automatically.

This change adds no database fields, migrations, new environment variables or provider dependencies. Deploy API and payment workers together because checkout and provider-link creation both use domain/liveGateway.js. Existing merchant credentials/webhook secrets do not need regeneration. No live keys, account connections or real payments were used during local verification.

References: [Razorpay API authentication](https://razorpay.com/docs/api/authentication/), [Webhook signature validation](https://razorpay.com/docs/webhooks/validate-test/).
