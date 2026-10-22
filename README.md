# WaterCycle

A biology check-in and bathroom-pass app for a classroom. Built with Next.js, React, TypeScript, and PostgreSQL. Ready to deploy to Vercel with a managed PostgreSQL database.

## Preview in GitHub Codespaces

Create a Codespace from this repository's **main** branch. The included dev container uses Node.js 24, installs the dependencies, prepares the local sample classroom, and forwards port **3000**.

Once container setup finishes, run:

```bash
npm run dev
```

In the Codespaces **Ports** tab, open port **3000** in your browser. Choose **Fill teacher demo** or **Fill student demo**, then **Sign in**. These accounts use sample data, and the preview port can stay private. The forwarded Codespaces hostname is allowed automatically during development.

If you already opened a Codespace before the app was pushed, pull the updated `main` branch and choose **Codespaces: Rebuild Container**, or create a new Codespace from `main`.

## What it does

- Students create an account using their first name, last name, a classroom code, and a password. They sign in with `firstnamelastname` and their password.
- Each pass starts with **two random, distinct, active biology multiple-choice questions**. Both answers must be correct. Missed questions include explanations; students can try a new pair.
- At most **two students have a space reserved or are out**. Other students join a first-in, first-out queue. Returning or cancelling immediately promotes the next person.
- Students get a prominent turn alert and browser-title change. They can enable sound and browser notifications. Keep the page open; browsers may throttle background pages and notifications require permission. There are no closed-app push notifications.
- **I'm leaving** records actual departure. **I'm back** records return and releases the space. Reloading or signing out does not lose a pass.
- Teachers manage the student roster, enable/disable accounts, reset student passwords, create/edit/activate/delete questions, review trips, download CSV, and manage the classroom name and enrollment code.
- Teacher resets invalidate existing sessions and require the student to choose a new password. Disabling a student releases their pass.

A teacher and one classroom are supported per deployment. Twenty editable biology questions are included as a starting bank. Two active questions are required to issue passes.

## Run locally

Use Node.js **22 or newer** and npm. The repository's lockfile pins dependencies.

```bash
npm install
cp .env.example .env.local
```

For a local demo, set these values in `.env.local`:

```dotenv
LOCAL_DATABASE=true
DEMO_MODE=true
```

Then seed and start:

```bash
LOCAL_DATABASE=true npm run db:seed
npm run dev
```

The seed command reads process environment variables, rather than Next.js's `.env.local` loader, so its `LOCAL_DATABASE=true` prefix is intentional. It refuses to run against `DATABASE_URL` and preserves an existing teacher. Local data lives in ignored `.local/data`; do not run multiple independent app processes against the same local database directory.

See [local database safety](docs/local-database.md) for process locking and recovery guidance.

The sign-in page offers **Fill teacher demo** and **Fill student demo** buttons when both local demo flags are enabled. Click **Sign in** after filling.

| Role | Username | Password |
| --- | --- | --- |
| Teacher | `morganreed` | `WaterCycle2026!` |
| Student | `jamiechen` | `Biology2026!` |
| Other demo students | `alexrivera`, `sampatel` | `Biology2026!` |

The demo classroom code is `BIO2026`. These are public development-only accounts. Never seed or enable this demo on a public deployment.

For a fresh local classroom instead, omit seeding and `DEMO_MODE`, set a private `TEACHER_SETUP_KEY` in `.env.local`, and use **Set up the first teacher account** on the sign-in page.

## Deploy to Vercel

1. Push this repository to GitHub and import it into Vercel as a **Next.js** project. Use the repository root as the project directory. The default build command is `npm run build`; no custom output directory is needed.
2. Create a managed PostgreSQL database, such as Neon through the Vercel Marketplace. Set **`DATABASE_URL`** in the Vercel project's environment settings to the provider's PostgreSQL connection string. Prefer the pooled connection URL, retaining its TLS settings (typically `sslmode=require`). Both application and database should be in nearby regions.
3. Set a long random **`TEACHER_SETUP_KEY`** securely in the same settings. For example, generate a value locally with `openssl rand -hex 32`. Do not commit it.
4. **Do not set `LOCAL_DATABASE` or `DEMO_MODE` on Vercel.** Deploy. The database schema is initialized automatically on first use, with initialization serialized across instances. No browser receives the database connection string.
5. Open the deployed app, choose **Set up the first teacher account**, and enter the setup key, your teacher credentials, and classroom name. The first-teacher form closes after successful setup. Remove `TEACHER_SETUP_KEY` from Vercel settings afterward and redeploy.
6. Sign in as the teacher. In **Classroom settings**, copy the enrollment code and share it with students. Add roster names ahead of time if desired; students can claim those unregistered entries with the same first/last name. Otherwise, signing up with the classroom code adds a new student.
7. Customize the questions before using the app in class. Students need two correct answers to join the queue. Leave the student page open for turn alerts.

Vercel's local filesystem does not persist application data. This app intentionally requires `DATABASE_URL` in production and uses PostgreSQL for sessions, quiz challenges, trips, rate limits, and queue transactions. The local PGlite database is for development and tests only. A live Vercel deployment has not been performed by this repository setup.

## Teacher controls

- **Overview:** see two pass spaces, the waiting queue, and recent activity. Mark an out student as returned or cancel a queued/reserved request when needed.
- **Student roster:** add names, reset passwords, disable or re-enable accounts. New students choose their password at sign-up. Usernames are normalized first + last name, without spaces/diacritics/punctuation. Duplicate usernames are rejected; use a distinguishing middle name/initial in the first-name field if two names collide.
- **Question bank:** manage four-option questions, correct answers, topics, explanations, and active status. Deleted questions stop appearing in future quizzes; in-progress quizzes retain a snapshot. The initial bank can be edited, deactivated, or replaced.
- **Trip history:** filter by date, student, and status; export the full classroom record as CSV. The on-screen history shows the latest 1,000 completed/cancelled requests; current requests remain visible. The student view shows their latest 10 completed/cancelled requests.
- **Classroom settings:** change the classroom name or regenerate the enrollment code. Regeneration stops new sign-ups using the old code; existing accounts remain valid.

A reserved spot stays reserved until the student leaves or cancels, or the teacher cancels it. Daily summary counts use the database day boundary (UTC by default); browser timestamps and date filters use the viewer's local timezone. CSV timestamps are labeled UTC.

## Verification

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
```

The backend tests use a separate, in-memory PostgreSQL-compatible database. They exercise password hashing/sessions, teacher-only setup, signup/roster claims, quiz expiry/replay/correctness, strict concurrent capacity/FIFO promotion, classroom isolation, resets/disabling, and CSV exports. Browser tests recreate an isolated demo database under `.local/e2e-data` for each run (your application data is preserved) on port 3100 and a separate Next build directory. They cover the complete three-student queue flow, first-time registration, teacher management, and a narrow mobile screen.

Browser tests use Chromium at `/usr/bin/chromium` when available. Otherwise, run `npx playwright install chromium` once to install Playwright’s browser. You can also set `CHROMIUM_PATH` to another Chromium executable.

## Implementation notes

Queue mutations hold a database row lock on the classroom. Both `ready` and `out` count toward the two-space limit, so simultaneous student requests cannot overbook. Quiz answers are checked server-side using one-use, 15-minute question snapshots. Students receive only their own visits and aggregate queue counts.

Passwords use salted scrypt hashes. Sessions are random, stored hashed in the database, and sent through HttpOnly, SameSite cookies (Secure on HTTPS). Mutations enforce same-origin requests and validate input; teacher authorization is checked on every teacher operation. Login attempts are rate-limited, and exports neutralize spreadsheet formula cells. Keep PostgreSQL backups through your chosen provider.

Git commits track the scaffold, student experience, teacher portal, backend, and verification work. Source files, dependency manifests, and configuration belong in Git; local databases, passwords, environment files, installed dependencies, and generated builds remain ignored.
