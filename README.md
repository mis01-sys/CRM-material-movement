# AAA Fastener Material Movement Portal

The AAA Fastener Material Movement Portal is an order and production-tracking workspace for customer service, shop-floor executives, and administrators. It uses Express, EJS, and MongoDB.

## Run locally

1. Copy `.env.example` to `.env`, then set `MONGODB_URI`, `BOOTSTRAP_USERNAME`, and a unique `BOOTSTRAP_PASSWORD` of at least 12 characters.
2. Install dependencies with `npm install`.
3. Start the application with `npm run dev`.
4. Open `http://localhost:3000`.

The first configured bootstrap account is created as an `ADMIN` with all permissions. If that configured username already exists as another role, startup provisions it as an administrator. If credentials are omitted, startup continues only when the database already contains a user. The application connects to MongoDB before listening.

To interactively create a new administrator account, configure `MONGODB_URI` in `.env` and run:

```powershell
npm run createadmin
```

Enter the admin username and password when prompted. Password input is hidden, must be at least 12 characters, and is never placed in shell history. This command creates a new `ADMIN` account and does not modify an existing account with the same username. The existing `bootstrap-user` command remains available for provisioning or promoting a known bootstrap account.

## Workspace

- Workspace content is rendered as separate EJS pages on the server; each section has its own template under `views/pages`, with shared shell and form templates. Search and CRUD use regular URL navigation and HTML forms. Client-side JavaScript is limited to small enhancements such as delete confirmation and applying permission defaults.
- **CRM** has a dedicated dashboard and manages customers, orders, and the item catalog. It can track order status and each order's latest executive update.
- **EXECUTIVE** has a dedicated production dashboard, read-only access to customer and order details, and can record the next production-stage completion.
- **ADMIN** always has all supported permissions and an operations dashboard with user last-login times, CRM order changes, executive ledger activity, and user/catalog/workflow management.
- **All users** have a Settings page to change their password; other active sessions are revoked when the password changes.
- Administrators can customize permissions for CRM and Executive accounts; ADMIN accounts always retain full access. Role changes without a permission list restore that role's defaults. Legacy purchasing accounts migrate to CRM on sign-in.

The order form stores its production route as an ordered list of stage references. Executives record each stage in that exact sequence. Ledger entries are append-only, include the order's item and the authenticated user, and receive a server-generated timestamp. Once ledger activity exists, an order's core details cannot be changed or deleted; CRM/admin can still update its open/on-hold status. Referenced customers, items, or stages cannot be deleted.

Customer IDs are generated atomically in the `AAAC001` format. MongoDB collections are created automatically when records are first written.

## Main pages

- `/login` — sign in and sign out using an HTTP-only session cookie.
- `/admin`, `/crm`, `/executive` — dedicated role dashboards; users are redirected to the page for their assigned role.
- Each workspace has separate `/orders`, `/customers`, `/items` (CRM/admin), `/stages` (admin), `/ledger` (admin), `/users` (admin), and `/settings` pages as permitted by the user's role and permissions. Create and edit forms are separate pages; list search uses `?q=`. Data-list pages include an Excel export that downloads all matching records and preserves the current search query.

## API

Authentication:

- `POST /api/auth/login` accepts `{ "username": "...", "password": "..." }`.
- `POST /api/auth/logout` invalidates the active session.
- `GET /api/auth/me` returns the authenticated user's role and permissions.
- `PATCH /api/auth/password` updates the current user's password.

Administration:

- `GET /api/users` lists users.
- `POST /api/users` creates a user.
- `PATCH /api/users/:userId` updates role, permissions, or active status.
- `DELETE /api/users/:userId` removes an account when it has no ledger history; users with activity should be deactivated instead.
- These routes require `users:manage`; disabling a user revokes their sessions.

Production routes are mounted at `/api/production`:

- `GET|POST /customers`, `PATCH|DELETE /customers/:id`
- `GET|POST /items`, `PATCH|DELETE /items/:id`
- `GET|POST /stages`, `PATCH|DELETE /stages/:id`
- `GET|POST /orders`, `PATCH|DELETE /orders/:id`
- `GET|POST /ledger`
- `GET /dashboard`

List routes accept a `q` query parameter for searching. Customer, order, catalog, stage, and ledger actions enforce role permissions on the server; hiding a UI action is not the authorization boundary.

In production set `NODE_ENV=production` and serve the application over HTTPS so session cookies use the `Secure` flag.

## Tests

```powershell
npm test
```
