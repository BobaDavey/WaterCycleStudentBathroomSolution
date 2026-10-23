# WaterCycle

**A quick learning. A better flow.**

WaterCycle helps teachers manage classroom restroom and water breaks. Students answer biology questions, receive a fair turn, and record their departure and return. Teachers manage classes, approve student accounts, and review activity through a dedicated portal. A separate Developer Portal supports teacher account administration and problem reports.

Built with **Next.js, React, TypeScript, and PostgreSQL**, with the existing green and cream WaterCycle design.

## Development-only demo accounts

Every fresh Codespace automatically creates these accounts in its own isolated development database. Select the appropriate sign-in tab and enter the credentials manually. Both are enabled; the student is Active and enrolled in the demo teacher’s **Demo Biology** class, code **DEMO1**. No registration or approval is needed for these two samples.

| Portal | Username | Password |
| --- | --- | --- |
| Teacher | `teachertest` | `1234567890` |
| Student | `teststudent` | `1234567890` |

These public credentials are for local development only. They are never seeded into Vercel Production or Preview. Setup never resets passwords or account statuses in an existing database. No credential autofill buttons are shown in the app.

## Features at a glance

| Area | What WaterCycle supports |
| --- | --- |
| Student accounts | Registration with a class code, teacher approval, and Pending, Active, or Deactivated status |
| Learning before breaks | Restroom or water purpose selection and two correct biology answers, one question at a time |
| Classroom flow | Two shared break spaces per class, FIFO waiting lines, reserved turns, and departure/return timers |
| Teacher controls | Multiple classes, roster management, approvals, password resets, transfers, and account deactivation/reactivation |
| Activity tracking | Trip history, CSV exports, twelve-minute warnings, and Rule Offenders reports |
| Return corrections | Audited **Mark as Still Out** actions that retain the original departure time and handle capacity safely |
| Support | Teacher problem-report submission and developer-only ticket management |

## Student Portal

### Register and receive approval

1. Choose **Create a student account** on the main sign-in page.
2. Enter your name, username, password, and your teacher's **five-character enrollment code**. The suggested username is your first and last name together, without spaces.
3. A valid code identifies the correct teacher and class automatically. Codes accept English letters and numbers, ignore letter case, and retain leading zeros, for example `BIO01` or `00123`.
4. Your new account starts **Pending**. Sign in, complete the welcome tutorial, and wait for your teacher to approve it.
5. Once approved, the dashboard recognizes your Active status automatically. You can use the same account without registering again.

| Account status | Student access |
| --- | --- |
| Pending | Sign in, view permitted account information and activity, and complete the tutorial; approval is required before requesting a break |
| Active | Use the normal break workflow when the class and question bank are available |
| Deactivated | Sign in and view permitted information; new break requests are unavailable until the teacher reactivates the account |

Pending students see **Your account is awaiting teacher approval.** Clicking **Request a Break** opens an approval explanation. Deactivated students receive a status-specific explanation. Server checks also prevent these accounts from starting questions, qualifying for a new break, joining a queue, reserving a space, or departing.

### Request a break and return

1. Click **Request a Break**, choose **Use Restroom** or **Drink Water**, and continue to the biology questions.
2. Answer one question at a time until **Correct Answers: 2/2**. Correct answers accumulate; they do not have to be consecutive. A wrong answer shows feedback without resetting progress.
3. If a space is available and earlier waiters have been served, the break starts immediately after the second correct answer. **Your time is NOW, GRAB A PASS** appears and the server records departure.
4. If the class is full, join the FIFO queue. Waiting does not start your break timer. When called, you receive a **two-minute reservation** and click **I'm Leaving Now** to record departure.
5. Click **I'm Back** when you actually return. This records your return time and releases the space.

Restroom and water breaks share the same **two-student limit within each class**. Different classes have independent capacity and queues. Students can cancel a learning attempt or a waiting/reserved request. Unanswered reservations expire so the next eligible student can be called.

The learning attempt lasts 15 minutes and retains its question and progress through refreshes and sign-ins. Questions are drawn from the class's active bank, with unseen questions first and a notice when questions begin repeating. A bank needs at least two active questions to start learning. **How Breaks Work** reopens the tutorial later.

### Timers, warnings, and turn alerts

- Break timers use the original saved departure and server time, so refreshing does not restart them.
- Students are reminded to return within **10 minutes**.
- At **12 minutes**, a warning appears. **I Got It** dismisses and saves acknowledgment while the timer continues. An unacknowledged warning appears again after refresh or sign-in.
- A break becomes a Rule Offenders entry only when it lasts **longer than 12 minutes**. Each break counts once. Warnings do not automatically deactivate accounts or end trips.
- Turn alerts include an in-page message, a browser-title change, and optional sound/browser notifications. Keep the page open for prompt alerts; closed-app push notifications are not provided.

Students see their own records and aggregate classroom capacity, without access to other students' private records.

## Teacher Portal

Choose **I'm a teacher** on the main sign-in page. Teacher accounts are created by the administrator. **Create a teacher account** opens contact information for requesting an account. New or reset teachers must change their temporary password before managing classes.

| Page | Teacher controls |
| --- | --- |
| Overview | Live classroom activity, capacity, queues, daily statistics, and **Pending Student Approvals** across the teacher's classes, oldest registration first |
| Class Roster | Create, edit, archive, and restore classes; manage enrollment codes, periods, timezones, students, and account statuses |
| Question bank | Add, edit, pause, activate, or remove biology questions for the selected class |
| Trip history | Review departures, returns, and purposes; filter activity, export CSV, correct false returns, or open **Rule Offenders** |
| Report Problems | Submit a name, contact email, and problem description to the developer |
| Account Settings | Change the teacher account password through **Account Security** |

### Classes, enrollment, and approval

Each teacher can manage multiple class periods. Active enrollment codes must be unique across the application. Editing a class name, period, timezone, or code preserves its roster and history. Archiving stops new enrollment and break requests while keeping records available; students already outside can still return.

Approve registered Pending students from **Overview → Pending Student Approvals** or their class roster. The pending panel includes a count, name, username, class/period, and registration date. Approval records the responsible teacher and timestamp, removes the student from the pending list, and enables break access when the student's dashboard refreshes. Teachers can manage only students in their own classes.

Roster actions also support adding names before registration, viewing student records, resetting passwords, transferring students between the teacher's classes, and removing enrollment. Transfers and removals preserve the account and historical class attribution; an open trip is completed or its reservation cancelled. A removed student who self-enrolls with a new class code requires that class teacher's approval.

Deactivating a student cancels learning and waiting/reserved requests while preserving any outside break and its timer. The student can still sign in and record a real return; the teacher can also reconcile the active trip. Deactivation and reactivation require confirmation.

**Account Settings** contains only account security. Class names, codes, timezones, and the fixed two-space capacity information remain accessible through **Class Roster**.

### Correct an inaccurate return

Choose **Mark as Still Out** from recent activity, trip history, or student activity details when a student reports returning while still outside.

After confirmation, WaterCycle reopens the **same break record**, retains the original departure, and saves the incorrect return, correcting teacher, correction time, and reason in an audit history. For example, leaving at 10:00, incorrectly returning at 10:05, and being corrected at 10:08 results in an eight-minute running timer. The existing reminders, warning, and Rule Offenders calculation continue from 10:00.

If the released space has been reassigned, other students' active trips remain intact. The teacher sees the actual outside count and any temporary over-capacity condition. Further departures wait for space. Existing reserved turns keep their order, pause while blocked by the correction, and receive a fresh two-minute response window when space opens.

The usual correction window is **24 hours after return**. Older corrections require an explicit confirmation and a reason of at least 10 characters. The student must still be enrolled in the original class and have no other open break request. Duplicate simultaneous corrections are rejected. The student can use **I'm Back** again when they actually return.

### Rule Offenders

Open **Trip history → Rule Offenders** to see completed and ongoing breaks longer than 12 minutes. Search by student, filter the teacher's active or archived classes, and load older entries. The table shows student, class/period, violation date, duration, and total violations within the teacher's classes.

Entries are derived from reliable trip timestamps and retain the original class/teacher attribution after enrollment changes. Each class's configured IANA timezone controls violation dates, including daylight saving time. Other displayed times use the browser timezone; CSV timestamps are labeled UTC.

### Report a problem

Open **Report Problems** and complete **Your Name**, **Email Address**, and **Describe the Problem**. Reliable account information is prefilled and editable. All fields are required, and the server validates the email and saves the authenticated teacher association and submission time.

After the ticket is saved, **Report Submitted!** confirms success and the form clears. Failure preserves entered information for retry. Duplicate clicks and retries do not create duplicate tickets. Teachers have access to the reporting form and acknowledgment, without a ticket-history or developer-management page.

## Developer Portal

- **Dashboard:** application-wide teacher, class, student, and trip statistics.
- **Teachers:** create teacher accounts; edit account information; reset passwords; activate or deactivate teacher access. Deactivation preserves classes, rosters, questions, and history.
- **Classes and Students:** read-only oversight with teacher/class filters and activity records.
- **Problem Reports:** search by teacher name, email, or ticket ID; filter status; open full descriptions; load older reports; solve or reopen tickets. A sidebar badge counts tickets needing attention.

New tickets start **Need Attention**. Solving changes the status to **Solved**, records the resolution time and developer account, and preserves the submission. Reopening keeps prior resolution history. The default view shows unresolved tickets; the all-status view places unresolved tickets first, newest first within each status group. Teachers and students cannot access developer ticket APIs.

Problem reporting stores tickets in the app. Email sending, ticket replies, and direct messaging are not included; the developer contacts teachers externally using their supplied email.

## Preview WaterCycle on Another Computer or GitHub Codespace

1. Sign in to GitHub with your own authorized account and open this repository on **main**.
2. Select **Code → Codespaces → Create codespace on main**. Wait for the container setup to finish.
3. Setup automatically installs dependencies, writes an ignored local development configuration, initializes an isolated PostgreSQL-compatible PGlite database in **.local/data**, applies local migrations, and creates the demo accounts and class. No external database or shared secret is needed.
4. In the terminal, run:

   ```bash
   npm run dev
   ```

5. Open **Ports → 3000 → Open in Browser**. Keep the port **Private**. Each friend should open their own Codespace and its own forwarded page.
6. Choose **I’m a teacher**, then enter **teachertest / 1234567890**. The class roster contains **Test Student** in **Demo Biology**.
7. Sign out, choose **I’m a student**, then enter **teststudent / 1234567890**. This sample is already **Active** and can request restroom or water breaks immediately. Complete the questions, leave, then click **I'm Back** to record return.

Each checkout has its own ignored database. Your existing accounts, password changes, private Codespaces secrets, and production records are not part of a Git clone. The production Developer password is intentionally neither distributed nor copied: it authenticates against the protected production database, not a collaborator’s new local database.

### If automatic setup did not finish, or you are using your own computer

Use Node.js **22 or newer** (Codespaces uses Node.js 24). Stop any running WaterCycle server, then run:

```bash
npm install
npm run dev:setup
npm run dev:doctor
npm run dev
```

Open `http://localhost:3000` locally, or port 3000 in Codespaces. Setup loads the same development environment files as Next.js, refuses hosted/managed database settings, and never replaces an existing `.env.local`. An existing local configuration must specify `WATERCYCLE_ENVIRONMENT=development`, `LOCAL_DATABASE=true`, and `DEMO_MODE=true`; leave both database URL variables empty. Do not copy production secrets into a Codespace.

For an older Codespace, stop the server, run `git pull --ff-only origin main`, then the four commands above. **Codespaces: Rebuild Container** also reruns setup. Seeding is repeatable: it adds missing sample accounts and preserves existing passwords, approval statuses, transfers, removals, and history. If someone has intentionally changed a sample account, use that account’s current password/status; choose a new `LOCAL_DATABASE_PATH` for a separate fresh demo instead of deleting the old database.

### Optional development-only Developer Portal

No privileged account is created automatically. An authorized developer can stop the server and run:

```bash
npm run dev:admin
```

Choose a **new development-only password** of at least 12 characters at the hidden terminal prompt. Restart with `npm run dev`, open **/admin/login**, and sign in as **watercycledev** using that chosen password. This account is labeled **Development Administrator**, exists only in that isolated local database, and can manage only its demo records. Repeating the command preserves its existing password. Do not reuse a production password.

For unattended local tests only, `DEV_ADMIN_INITIAL_PASSWORD` can be supplied privately in the process environment. There is no default privileged password. Remove that initialization variable after use. The production administrator bootstrap remains a separate managed-database operator command; it is never called by local setup, seeding, install, build, or application startup.

### Troubleshoot login or setup

Stop the server before running `npm run dev:doctor`. It checks the database without changing records and explains configuration, initialization, migration, password, status, and enrollment failures.

| Symptom | What to do |
| --- | --- |
| Demo database/account not initialized | Run `npm run dev:setup`, then `npm run dev:doctor` |
| Incorrect username/password | Select the correct portal and type the development credentials above manually. If a password was changed locally, setup preserves it |
| Pending teacher approval | Newly registered accounts still require teacher approval. The fresh seeded `teststudent` is already Active |
| Deactivated account | Ask the local class teacher to reactivate it; setup does not undo intentional deactivation |
| Database unavailable or already open | Stop the other WaterCycle server/script. Preserve `.local/data`; do not delete it. Check the terminal and [local database safety](docs/local-database.md) |
| Migrations incomplete | Preserve the directory, run `dev:doctor`, then `dev:setup` after reviewing its instructions. Incompatible/future migration histories are refused |
| Missing/unsafe development configuration | Remove production URLs/secrets from Codespaces configuration. Use the local settings above; rerun setup |
| Developer sign-in fails | Run the optional `dev:admin` command and use `watercycledev` with your chosen development password. Production credentials do not initialize a local account |

Development server logs point out missing demo initialization and student approval/deactivation. Production sign-in responses remain generic and never disclose whether a username exists. `/api/health` remains a minimal availability check with no account or credential details.

### Additional local sample accounts

Legacy testing fixtures remain available: teachers `morganreed` / `mariamiller` use initial password `WaterCycle2026!`; students such as `jamiechen`, `alexrivera`, and `sampatel` use `Biology2026!`. These fixtures retain their four sample classes (`01001`, `01002`, `02001`, `02002`) alongside the primary demo class `DEMO1`. Existing changed passwords stay unchanged.

Local PGlite data is independent of managed PostgreSQL. Codespaces refuse managed database connections altogether. Other local previews may use only a managed database explicitly bound to **development**, with the existing identity and role checks. Hosted Preview and Production still require separate protected managed PostgreSQL databases. Local development administrator setup changes the administrator identity policy only inside the opted-in PGlite database; production schema, administrator identity, passwords, backup gates, and runtime restrictions remain unchanged.

## Deploy to Vercel with persistent data

Follow the [production database and recovery guide](docs/production-database.md) before classroom use. Production and Preview require separate managed PostgreSQL databases, separately scoped Vercel variables, and distinct database identities. Runtime database credentials cannot own tables, change schemas, truncate, or hard-delete classroom records.

Builds and server startup never migrate or seed a managed database. Reviewed migrations run through a separate operator command with a verified backup reference and expected schema version. Redeployments reconnect to the same persistent database and preserve existing accounts, passwords, sessions, rosters, activities, trips, and problem reports. An empty, incompatible, or incorrectly scoped database is refused rather than initialized automatically.

Vercel runs `npm ci` and `npm run build`; its local filesystem is not persistent storage. This repository update does not itself create a managed database, configure Vercel, or publish a deployment.

## Existing data and migrations

Schema migrations run transactionally and are versioned. Managed databases require explicit migration and environment binding; local development still initializes automatically. Migration 5 adds environment identity and migration audit tables without rewriting classroom records. Existing active student accounts remain Active; previously disabled students become Deactivated. Accounts, enrollment, passwords, biology activities, sessions, and historical trips are preserved. New registration and roster claims default to Pending.

The earlier class migration retained invalid legacy codes as `legacy_code`. Teachers must choose a valid five-character replacement in **Class Roster** before reopening enrollment. Ownership migration stops if an original class has missing or ambiguous teacher ownership. Historical trips retain their timestamps and show **Not recorded** where purpose was not previously collected; missing violation timestamps are not invented. Legacy learning attempts retired by the earlier break-workflow migration remain stored.

Back up a deployed database before applying migrations. Enrollment changes and return corrections retain historical class attribution and audit records.

## Verification and implementation

```bash
npm run typecheck
npm test
npm run test:e2e
npm run build
npm run test:postgres
npm run test:fresh
```

Automated coverage includes account approval and migration preservation, current-status enforcement, role/class ownership, teacher and developer authentication, password changes, class codes, roster actions, biology learning and retry protection, tutorials, FIFO/reservation concurrency, timers and warnings, Rule Offenders, return corrections and paused-capacity recovery, report validation and failed-form recovery, and developer ticket search, pagination, and status history.

The PostgreSQL persistence suite creates its own disposable Docker server, verifies repeated application/production-server restarts, and exercises an actual backup/restore. It never uses your `DATABASE_URL`. Docker and OpenSSL are required; run the production build first.

`npm run test:fresh` checks committed source in a separate temporary Git clone with its own dependency installation, environment, database, and HTTP server. It verifies exact demo logins, enrollment, breaks, opt-in local administrator access, repeated setup, preserved changed credentials/status/history, and rejected production settings. Commit your changes before running it; it does not test uncommitted edits.

Browser tests recreate only **`.local/e2e-data`**. They use a generated test administrator secret and do not reset the application database. Chromium at `/usr/bin/chromium` is used when available; otherwise run `npx playwright install chromium` or set `CHROMIUM_PATH`.

Classroom mutations use transactional row locks, and a student can have only one active break request. Question banks are snapshotted into class-scoped learning attempts, with opaque question tokens and idempotent answer handling. Passwords use salted scrypt hashes; sessions are stored hashed and use HttpOnly, SameSite cookies with Secure on HTTPS. Mutations enforce same-origin requests, validated inputs, and current role/ownership checks. CSV exports neutralize spreadsheet formula cells.

Application data, private environment files, real credentials, dependencies, and generated builds remain outside Git. The demo credentials above are intentionally published for testing.
