# WaterCycle

WaterCycle is a biology check-in and bathroom-pass app built with Next.js, React, TypeScript, and PostgreSQL. It supports one administrator, multiple teachers, and multiple class periods per teacher while retaining the original green and cream interface.

## Preview in GitHub Codespaces

Create a Codespace from this repository's **main** branch. The dev container uses Node.js 24, installs dependencies, and prepares the local sample classrooms. After setup finishes:

```bash
npm run dev
```

Open the **Ports** tab and choose **Open in Browser** for port **3000**. The preview port can stay private. The Codespaces forwarding hostname is allowed automatically during development. If an existing Codespace predates this update, pull `main`, stop the app, and run **Codespaces: Rebuild Container**, or create a new Codespace.

The sign-in page offers **Fill teacher demo** and **Fill student demo**, followed by **Sign in**. The demo is enabled only for an explicitly configured local database, never an external `DATABASE_URL`.

| Sample role | Username | Demo-only password |
| --- | --- | --- |
| Teacher | `morganreed` | `WaterCycle2026!` |
| Teacher | `mariamiller` | `WaterCycle2026!` |
| Student | `jamiechen` | `Biology2026!` |
| Students in the same class | `alexrivera`, `sampatel` | `Biology2026!` |

Morgan's original class uses **01001**, and another class uses **01002**. Maria's classes use **02001** and **02002**. The sample roster includes students in separate periods. Demo setup preserves existing accounts and records; it adds missing sample data without resetting passwords.

**There is no built-in administrator password.** The Admin Portal login workflow is available in the demo, but the sole administrator must be provisioned using your own private secret as described below. No public sample administrator password is substituted for yours.

## Provision the sole administrator privately

The administrator username is fixed to **`davidanzezhang`**. There is no administrator registration page and no operation to create another administrator, delete this account, demote it, or change its username. Database constraints and a protection trigger enforce those rules as well as the server APIs.

1. In your GitHub **Settings → Codespaces → Secrets**, create a repository-scoped secret named **`ADMIN_INITIAL_PASSWORD`**. Enter your chosen initial password privately there. Use at least eight characters; a long unique password is recommended. Do not put a real password into source files, `.env.example`, commits, screenshots, or chat.
2. Start or restart the Codespace so the secret is available to the process. On the first database initialization, the app securely hashes the secret and creates the administrator **only if no administrator exists**. The dev-container setup also initializes the database.
3. To provision explicitly, stop the local app first and run:

   ```bash
   npm run admin:bootstrap
   npm run dev
   ```

4. Open **`/admin/login`** under the same preview address, or click **Administrator sign in** on the main sign-in page. Sign in with `davidanzezhang` and your private password. Successful sign-in opens **`/admin/dashboard`**.
5. After provisioning, remove `ADMIN_INITIAL_PASSWORD` from your Codespaces secrets and restart the Codespace. The stored hash remains valid. Startup never resets an existing administrator's password, even if this variable is later changed. Use **Admin Settings** to change the password securely.

For a Vercel deployment, supply `ADMIN_INITIAL_PASSWORD` privately in the project's environment settings for initial provisioning, then remove it and redeploy after successful setup. A private local `.env.local` may also provide the variable; it is ignored by Git and the CLI loads it without printing values. Proxy-backed HTTP credential placeholders are not suitable for a password that must be hashed locally; use an actual process environment secret.

If the private secret is absent, the app does **not** invent a password. Existing teacher and student accounts continue to work. The Admin Portal explains the provisioning step. If a non-administrator already owns the reserved username, provisioning fails clearly and leaves that account untouched; resolve the username conflict deliberately before retrying.

## Administrator workflow

The administrator has a separate portal and sidebar:

- **Dashboard:** teacher totals, active/inactive teachers, active classes, registered students, and existing usage statistics.
- **Teachers:** search, create, edit, activate/deactivate, and reset teacher credentials. Creation accepts a name, username or email, temporary password, and status. New and reset teachers must change that password before managing classes. Passwords are hashed and existing passwords are never displayed.
- **Classes:** view classes across teachers, filter by teacher, and open a class roster and its activity.
- **Students:** view student accounts and enrollment information, filtered by teacher and class.
- **Admin Settings:** edit profile information and change the administrator password. The username remains fixed.

Teacher deactivation revokes login access while preserving classes, student accounts, enrollments, questions, and history. Classroom and student-record oversight is read-only in the administrator portal; teacher account management is explicitly writable. Teacher accounts are created by the administrator; the former public first-teacher setup route is retired.

## Teacher workflow

Sign in on the main page using **I'm a teacher**. Administrators supply new teachers with a temporary password; change it at the first sign-in.

1. Open **Class Roster**. The overview lists your classes, periods, enrollment codes, and student counts, with an archived-class view.
2. Choose **Create Class**. Enter a name, optional period, and your chosen **five-digit numerical code**. Leading zeros are preserved. Active codes are unique across all teachers; duplicates are rejected by both the API and database.
3. Use **Edit Class** to change names, periods, and codes. Changing a code preserves students and history. **Archive Class** requires confirmation, prevents new enrollment and learning/pass requests, and retains historical records. Students already out can still record their return.
4. Choose **View Class** to manage that class's roster. Search students, add names ahead of registration, view student details and records, reset passwords, or disable accounts. Removing a student from a class keeps their account and history. Transfers are limited to another active class owned by the same teacher and preserve past activity under its original class.
5. Select the class for **Overview**, **Question bank**, and **Trip history**. Questions and trips remain scoped to that class. Enrollment-code and class-name controls live only in **Class Roster**; **Classroom settings** retains account security.

Roster removals and transfers require confirmation. If a student has an active pass, the operation finishes an out trip or cancels a reservation, records the change without deleting history, and releases the old class's space. A removed student can sign in and join another active class with its valid code.

## Student workflow

1. On the main sign-in page, choose **Create a student account**.
2. Enter first name, last name, username, password, and the teacher's five-digit classroom code. The suggested username is `firstnamelastname`; it can be changed to an available username containing letters and numbers.
3. A valid code automatically identifies the correct teacher and class. There is no teacher/period selection step. Invalid, archived, and unavailable codes show an error without creating an account. A pre-added roster entry can be claimed once; duplicate usernames and active enrollments are rejected.
4. Sign in later with that username and password. Existing usernames and passwords continue working.
5. Request a pass and answer **two random, distinct, active biology multiple-choice questions** correctly. Wrong answers include explanations; start a fresh pair to try again.
6. At most **two students per class** may be reserved or out. Additional requests join a first-in, first-out queue. Returning or cancelling promotes the next student.
7. **I'm leaving** records actual departure, and **I'm back** records return. Reloading or signing out does not lose a pass.

Students see their own account and history plus aggregate capacity counts, never other students' private records. Turn alerts include a prominent in-page message, browser-title change, and optional sound/browser notifications. Keep the page open; browsers can throttle background pages and closed-app push notifications are not provided.

## Migration and existing records

Schema changes run transactionally and are recorded so they can be applied again safely. Existing teachers are associated with their original classrooms. Existing student enrollment, questions, quizzes, sessions, and trip timestamps are preserved. New class ownership and enrollment relationships enforce teacher isolation and prevent duplicate active student enrollments.

An old enrollment code that is not exactly five digits is retained as `legacy_code` for reference, while its active code becomes unset. **The teacher must choose a new five-digit code in Class Roster before accepting new students.** The app does not select a real classroom's code on the teacher's behalf. Existing enrolled students and history remain attached to the same class. The opt-in sample-data setup updates the known old sample code to the documented sample code.

Migration stops instead of guessing if an old class has no identifiable teacher or has ambiguous ownership. Back up the database before deploying a schema update and resolve such ownership deliberately. Archived class codes are inactive; a code can be used by only one active class at a time.

## Local development outside Codespaces

Use Node.js **22 or newer** and npm; Node.js 24 is used in the dev container.

```bash
npm install
cp .env.example .env.local
```

For local sample data, set `LOCAL_DATABASE=true` and `DEMO_MODE=true` in ignored `.env.local`, then:

```bash
LOCAL_DATABASE=true npm run db:seed
npm run dev
```

The explicit seed command reads process variables rather than loading Next.js's `.env.local` automatically, so the prefix is intentional. It refuses to run against an external `DATABASE_URL` and does not seed an administrator with a substitute password.

Local PGlite data lives under ignored `.local/data`. Stop the server before a seed or bootstrap command uses that same directory. Separate instances need separate `LOCAL_DATABASE_PATH` values. See [local database safety](docs/local-database.md). The schema and administrator CLI also work with a managed PostgreSQL `DATABASE_URL`.

## Deploy to Vercel

1. Import this GitHub repository into Vercel as a **Next.js** project, using the repository root. Build command: `npm run build`; use the default output directory.
2. Connect a managed PostgreSQL database, such as Neon, and set **`DATABASE_URL`** privately in Vercel project settings. Prefer the pooled URL and retain its TLS settings (typically `sslmode=require`).
3. Set **`ADMIN_INITIAL_PASSWORD`** privately for first administrator provisioning. **Do not enable `LOCAL_DATABASE` or `DEMO_MODE` on Vercel.**
4. Deploy, open the app, then sign in at **`/admin/login`** using `davidanzezhang` and your private initial password. Remove the initial-password variable and redeploy after successful provisioning.
5. Create teachers in the Admin Portal, have teachers change their temporary passwords and create class codes, and have students register with those codes.

Vercel's local filesystem is not persistent storage. Production requires PostgreSQL for all accounts, sessions, enrollments, quiz challenges, trips, rate limits, and queue transactions. Publication of a cloud development snapshot is separate from deployment to Vercel. This repository update alone does not claim a live Vercel deployment.

## Verification

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e
```

Tests cover legacy-data migration, private/idempotent administrator provisioning, singleton protection, teacher/class ownership, temporary-password changes, five-digit code uniqueness and leading zeros, enrollment validation, transfers/history, archived classes, roster isolation, queue concurrency/FIFO, quiz correctness/expiry/replay, sessions/passwords, and exports. Browser tests recreate only the isolated `.local/e2e-data` fixture. They never reset application data or need your real administrator password; any test administrator secret is generated privately at runtime.

Browser tests use Chromium at `/usr/bin/chromium` when present. Otherwise run `npx playwright install chromium`, or set `CHROMIUM_PATH` to your Chromium executable.

## Implementation notes

Classroom mutations use database row locks and reserve both `ready` and `out` passes toward the two-space limit. Quiz answers remain server-side in one-use, 15-minute class-scoped snapshots. Students cannot reuse a challenge after a class transfer.

Passwords use salted scrypt hashes. Random sessions are stored hashed and sent through HttpOnly, SameSite cookies, with Secure cookies on HTTPS. Mutations enforce same-origin requests and validated inputs; every privileged query checks the current role and class ownership. Password resets invalidate existing sessions. Exports neutralize spreadsheet formula cells.

A reserved spot lasts until the student leaves, cancels, or the teacher releases it. Daily summaries use the database day boundary (UTC by default); displayed timestamps use the viewer's local timezone and CSV timestamps are labeled UTC. Keep PostgreSQL backups through your provider.

Source, dependency manifests, tests, and configuration belong in Git. Real passwords, local databases, private environment files, generated builds, dependencies, and claim tokens remain ignored.
