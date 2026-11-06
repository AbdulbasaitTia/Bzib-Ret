# Nasara Motors — inquiry emails

Every "Send an inquiry" form submission is saved (as before) **and** emailed to
**Iddrisdecons@gmail.com**. The email is sent with [Resend](https://resend.com) (free plan).

`src/worker.js` is the live `nasara-motors` worker with this added.

## One-time setup

1. Sign up at resend.com **using Iddrisdecons@gmail.com** and create an API key.
   (Without a verified domain, Resend only delivers to the account's own email,
   so the account must be on that address.)
2. Cloudflare dashboard → Workers & Pages → **nasara-motors** → Settings →
   Variables and Secrets → add a **Secret** `RESEND_API_KEY` = the key.
3. Deploy `src/worker.js` (replace the worker code in the dashboard editor,
   or `wrangler deploy` from the project that has the `public/` folder).

Optional variables:
- `INQUIRY_EMAIL` — send to a different address (default Iddrisdecons@gmail.com).
- `INQUIRY_FROM` — sender, once a domain is verified in Resend
  (default `Nasara Motors <onboarding@resend.dev>`).

If the key is missing or email fails, the inquiry is still saved and shows in the admin page.
