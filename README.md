# WaterCycle

**A quick learning. A better flow.**

WaterCycle helps teachers manage classroom restroom and water breaks. Students answer biology questions, receive a fair turn, and record their departure and return. Teachers manage classes, approve class enrollments, and review activity through a dedicated portal. A separate Developer Portal supports teacher account administration and problem reports.

Built with **Next.js, React, TypeScript, and PostgreSQL**, with the existing green and cream WaterCycle design.

## Development-only demo accounts

Every fresh Codespace automatically creates these accounts in its own isolated development database. Select the appropriate sign-in tab and enter the credentials manually. Both are enabled; the student is Active with Approved enrollments in both demo classes below. No registration or approval is needed for these two samples.

| Portal | Username | Password |
| --- | --- | --- |
| Teacher | `teachertest` | `1234567890` |
| Student | `teststudent` | `1234567890` |

These public credentials are for local development only. They are never seeded into Vercel Production or Preview. Setup never resets passwords or account statuses in an existing database. No credential autofill buttons are shown in the app.

The demo teacher owns these exact fresh-development classes (Eastern time, Monday–Friday):

| Class | Code | Session |
| --- | --- | --- |
| Demo Biology Morning | `DEMO1` | 7:00 AM–1:00 PM |
| Demo Chemistry Afternoon | `DEMO2` | 1:00 PM–6:00 PM |

`teststudent` is approved in both for immediate testing during those hours. Create another student to test **My Classes → Join a Class → Pending → teacher approval**. Outside those hours or on weekends, no new demo breaks are permitted; the teacher can edit schedules for weekday testing. Repeated initialization preserves intentional changes in an existing local database rather than restoring defaults.

## Features at a glance

| Area | What WaterCycle supports |
| --- | --- |
| Student accounts | Automatic sequential usernames; one permanent account with multiple independently approved class enrollments |
| Learning before breaks | Restroom or water purpose selection and two correct biology answers, one question at a time |
| Classroom flow | Two shared break spaces per class, FIFO waiting lines, reserved turns, and departure/return timers |
| Teacher controls | Class schedules/time zones, roster approvals, password resets, transfers, and enrollment deactivation/reactivation |
| Activity tracking | Trip history, CSV exports, twelve-minute warnings, and Rule Offenders reports |
| Return corrections | Audited **Mark as Still Out** actions that retain the original departure time and handle capacity safely |
| Support | Teacher problem-report submission and developer-only ticket management |

## Student Portal

### Register once and join your classes

1. Choose **Create a student account** and enter your first name, last name, and password. No class code or chosen username is required.
2. WaterCycle assigns your saved username on the server: normalized lowercase first + last name, then `01`, `02`, and so on (continuing to `100` after `99`). Spaces, accents, and punctuation are normalized consistently; names that contain no English letters/numbers use `student` as the base. Duplicate names are welcome, usernames are globally unique, and existing usernames never change.
3. Read **Your Username Is**, use **Copy username**, then **Continue to Student Portal**. Remember this username for sign-in; it also appears in your account information and **My Classes**.
4. Choose **+ Join a Class**, enter the teacher's five-character code, check the displayed class/teacher, and confirm. Codes are case-insensitive English letters/numbers and retain leading zeros.
5. **Class Joined! Waiting for Teacher Approval.** Each enrollment starts Pending. Join other teachers’ classes with the same permanent account.

| Enrollment status | Break access for that class |
| --- | --- |
| Pending Approval | Wait for that class’s teacher to approve |
| Approved | Request during the class’s scheduled session, subject to existing break rules |
| Deactivated | Contact that class’s teacher to reactivate enrollment |

Approval or deactivation in one class does not affect another. Account-wide security restrictions remain separate. Students see their own class names, teachers, schedules, time zones, enrollment statuses, eligibility, and historical trips. Teachers see only their own memberships and class-specific activity.

### Class sessions

Teachers configure **start time**, **end time**, and one of the seven U.S. time zones in Class Roster. Sessions recur **Monday–Friday**. Start is inclusive; end is exclusive. Equal/overnight times are rejected. An existing class with no saved schedule cannot accept new breaks until its teacher sets one; no arbitrary hours are assigned during migration.

The server uses its own time and IANA daylight-saving rules. A student’s computer clock or time zone cannot grant access. If exactly one approved class is eligible, it is selected automatically. If approved sessions overlap, the student must select which class they are attending. With none available, **No Eligible Class in Session** explains the restriction. The question bank and all existing capacity/security checks still apply.

When a class ends, waiting requests and reservations are cancelled with an explanation on the next queue check (student/teacher polling or an action); they cannot depart after the end. An already active break continues from its original UTC departure, including reminders, warnings, return, and teacher correction controls. A student may have only one learning attempt and one active/pending break across all classes.

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
| Overview | Live classroom activity, capacity, queues, daily statistics, and **Pending Student Approvals** across the teacher's classes, oldest enrollment request first |
| Class Roster | Create, edit, archive, and restore classes; manage enrollment codes, periods, timezones, start/end times, students, and enrollment statuses |
| Question bank | Add, edit, pause, activate, or remove biology questions for the selected class |
| Trip history | Review departures, returns, and purposes; filter activity, export CSV, correct false returns, or open **Rule Offenders** |
| Report Problems | Submit a name, contact email, and problem description to the developer |
| Account Settings | Change the teacher account password through **Account Security** |

### Classes, enrollment, and approval

Each teacher can manage multiple class periods. Active enrollment codes must be unique across the application. Editing a class name, period, timezone, or code preserves its roster and history. Archiving stops new enrollment and break requests while keeping records available; students already outside can still return.

Approve registered Pending students from **Overview → Pending Student Approvals** or their class roster. The pending panel includes a count, name, username, class/period, and registration date. Approval records the responsible teacher and timestamp, removes the student from the pending list, and enables break access when the student's dashboard refreshes. Approval is specific to the indicated class. Teachers can manage only enrollments and activity in their own classes; shared students' unrelated records remain private.

Roster actions also support creating a separate roster account with a server-assigned username (set a temporary password before approving, then give that username/password privately to the student), viewing student records, resetting passwords, transferring students between the teacher's classes, and removing enrollment. Transfers and removals preserve the account and historical class attribution; an open trip is completed or its reservation cancelled. A removed student who self-enrolls with a new class code requires that class teacher's approval.

Deactivating an enrollment cancels that class’s learning and waiting/reserved requests while preserving any outside break and its timer. The student can still sign in and record a real return; the teacher can also reconcile the active trip. Deactivation and reactivation require confirmation and never alter other enrollments or clear account-wide suspension. Password resets affect the permanent account and all its sessions; share temporary passwords privately.

**Account Settings** contains only account security. Class names, codes, timezones, and the fixed two-space capacity information remain accessible through **Class Roster**.

### Correct an inaccurate return

Choose **Mark as Still Out** from recent activity, trip history, or student activity details when a student reports returning while still outside.

After confirmation, WaterCycle reopens the **same break record**, retains the original departure, and saves the incorrect return, correcting teacher, correction time, and reason in an audit history. For example, leaving at 10:00, incorrectly returning at 10:05, and being corrected at 10:08 results in an eight-minute running timer. The existing reminders, warning, and Rule Offenders calculation continue from 10:00.

If the released space has been reassigned, other students' active trips remain intact. The teacher sees the actual outside count and any temporary over-capacity condition. Further departures wait for space. Existing reserved turns keep their order, pause while blocked by the correction, and receive a fresh two-minute response window when space opens.

The usual correction window is **24 hours after return**. Older corrections require an explicit confirmation and a reason of at least 10 characters. The student must still be enrolled in the original class and have no other open break request. Duplicate simultaneous corrections are rejected. The student can use **I'm Back** again when they actually return.

### Class time zones

Create or edit a class in **Class Roster** to choose **USA / Eastern (Default)**, **USA / Central**, **USA / Mountain**, **USA / Pacific**, **USA / Alaska**, **USA / Hawaii**, or **USA / Arizona Mountain**, in that order. New classes and missing settings default to Eastern. Existing saved IANA preferences are retained, including a current setting outside this U.S. menu.

Students inherit their class’s setting automatically. IANA rules handle daylight saving time; Hawaii and Arizona Mountain remain on standard time. Changing a zone changes the displayed clock/calendar only: saved UTC instants, durations, reservations, account records, and classroom history remain intact. Only the owning teacher can edit a class.

The Overview uses consistent **24px** gaps between pending approvals, statistics, live classroom panels, and recent activity on desktop, tablet, and mobile.

### Rule Offenders

Open **Trip history → Rule Offenders** to see completed and ongoing breaks longer than 12 minutes. Search by student, filter the teacher's active or archived classes, and load older entries. The table shows student, class/period, violation date, duration, and total violations within the teacher's classes.

Entries are derived from reliable trip timestamps and retain the original class/teacher attribution after enrollment changes. Each class's configured IANA timezone controls violation dates, including daylight saving time. Classroom activity dates, registrations, departures, returns, reservations, and correction audit times use the relevant class’s selected time zone in both portals and Developer class oversight. Historical trips retain their original class association after transfers. Date filters follow that class’s calendar. CSV timestamps remain labeled UTC, and timers, queue rules, and daily statistics calculations are unchanged.

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

## Testing WaterCycle in Your Own GitHub Codespace

1. Sign in to your authorized GitHub account and open this repository on **main**.
2. Select **Code → Codespaces → Create codespace on main**. Wait for setup to finish.
3. Setup automatically installs dependencies, creates an ignored local configuration, initializes an isolated PostgreSQL-compatible PGlite database in **.local/data**, applies local migrations, and creates the demo teacher, Active student, both scheduled classes **DEMO1 / DEMO2**, Approved test enrollments, and question banks.
4. If your Codespace has the private Developer provisioning secret described below, setup also creates the single development Developer account automatically. Without it, student and teacher demos still work and setup explains how to enable Developer access.
5. In the terminal, run:

   ```bash
   npm run dev
   ```

6. Open **Ports → 3000 → Open in Browser**. Keep the port **Private**. Each tester should open the forwarded page from their own Codespace.
7. Select the appropriate sign-in tab and enter these development credentials manually:

   | Portal | Username | Password | Status |
   | --- | --- | --- | --- |
   | Student | `teststudent` | `1234567890` | Active |
   | Teacher | `teachertest` | `1234567890` | Active |

The student is approved in both scheduled demo classes and needs no registration or approval. Breaks are available only during an approved class session; outside school hours the dashboard correctly shows no eligible session. The teacher can view that student in **Class Roster**. New students register first, join classes from My Classes, and require each class teacher’s approval. No public demo autofill buttons are included.

### Private Developer password: configure once for each authorized tester

The development Developer username is **davidanzezhang**. Enter it and the privately supplied password manually at **/admin/login**; neither field is prefilled. The password is never published here or in the source code. The account is created automatically only when a private secret is supplied; there is no default or substitute privileged password.

**Repository owner:** In GitHub, open this repository’s **Settings → Secrets and variables → Codespaces → New repository secret**. Name it **DEV_ADMIN_INITIAL_PASSWORD**, enter the intended private development Developer password, and save it. Use a **Codespaces** secret, not an Actions or Dependabot secret. GitHub access policies determine which collaborators can receive a repository secret.

**Reliable procedure for another tester:** Your personal secret does not automatically transfer to somebody else’s independently owned Codespace. If a repository secret is unavailable to your friend, securely share the development password with that authorized person outside the repository. Have them open their own **GitHub Settings → Codespaces → Secrets → New secret**, use the name **DEV_ADMIN_INITIAL_PASSWORD**, enter that password, and select **WaterCycleStudentBathroomSolution** under repository access. They should then create a new Codespace, or stop and restart an existing one so GitHub injects the secret.

The existing private **ADMIN_INITIAL_PASSWORD** name also works in an isolated local development environment. If both names are configured, **DEV_ADMIN_INITIAL_PASSWORD** takes precedence. Do not use `NEXT_PUBLIC_` names. Never add production database URLs, Neon connection credentials, or production-only operator secrets to a testing Codespace.

No manual `admin:bootstrap` command is needed. Post-create setup, the post-start hook, and the `npm run dev` preflight initialize missing local accounts. This also handles a secret that becomes available after a prebuild. If the account already exists, its password is preserved; changing a secret does not reset that password. The single-administrator index and protection against deletion, renaming, demotion, or disabling remain enforced.

### Confirm setup and troubleshoot

Stop the server with **Ctrl+C**, then run:

```bash
npm run dev:check
```

This checks connectivity, migrations, both demo account passwords and Active status, enrollment under the correct teacher, the single Developer account, its password when the private secret is available, and separation from managed production data. It never prints passwords, password hashes, or database connection strings. `npm run dev:doctor` remains an alias.

If dependencies or automatic setup did not finish, run:

```bash
npm install
npm run dev:setup
npm run dev:check
npm run dev
```

For an older Codespace, stop the server and run `git pull --ff-only origin main` first. Rebuild the container to load updated lifecycle hooks. On your own computer use Node.js **22 or newer**; the container uses Node.js 24. Local secret configuration can also be stored privately in ignored `.env.local`, alongside `WATERCYCLE_ENVIRONMENT=development`, `LOCAL_DATABASE=true`, and `DEMO_MODE=true`. Never commit that file.

| Issue | What to do |
| --- | --- |
| Demo accounts missing or incorrect-credentials error | Confirm this Codespace uses current **main**, stop the server, run `npm run dev:setup`, then `npm run dev:check`. Setup failures are shown and prevent an unusable dev server from starting |
| Developer secret missing | Configure a private **Codespaces** secret as above, stop and restart the Codespace, then run `npm run dev`; student/teacher demos remain available without it |
| Developer secret differs from saved password | Use the account’s current password or correct the secret. Setup never resets existing passwords |
| Student Pending or Deactivated | New non-demo class enrollments require approval. A fresh `teststudent` is Active; deliberate later status changes are preserved and must be managed by its teacher |
| Local database already open | Stop the other WaterCycle server or script before setup/check commands. A post-start hook preserves a database already held by a running server |
| Database migration/configuration error | Follow the specific terminal error. Preserve `.local/data`; never delete it to fix login. Managed database URLs are refused in Codespaces |
| Prior local administrator uses a different username | Preserve that database and its existing access. For the required fresh accounts, choose a new ignored `LOCAL_DATABASE_PATH` and run setup; no administrator is renamed or added to an existing database |

Initialization keeps a development-only seed-identity table in the isolated local database so deliberate account/class renames, code edits, and schedule edits are not recreated or undone. It is never created by managed production startup or migrations. Initialization is repeatable: it adds missing accounts without duplicating classes/enrollments or replacing existing passwords, statuses, transfers, removals, and history. To create a separate fresh demo, choose a new ignored `LOCAL_DATABASE_PATH`; keep the old database intact. See [local database safety](docs/local-database.md).

### Preview WaterCycle on Another Computer or GitHub Codespace

Follow the steps above in a new checkout. Each checkout has an independent ignored database: existing accounts, sessions, and private environment settings do not clone with Git. Local development and production may use the same Developer username, but authenticate against separate databases and separately configured password hashes. Source access and local Developer access do not grant access to production records. Codespaces refuse managed connections, and Production/Preview still require their protected, separate managed PostgreSQL configurations.

Legacy testing fixtures remain available: teachers `morganreed` / `mariamiller` use initial password `WaterCycle2026!`; students such as `jamiechen`, `alexrivera`, and `sampatel` use `Biology2026!`. Their four sample classes remain alongside `DEMO1` and `DEMO2`. Previously changed passwords remain unchanged.

## Deploy to Vercel with persistent data

Follow the [production database and recovery guide](docs/production-database.md) before classroom use. Production and Preview require separate managed PostgreSQL databases, separately scoped Vercel variables, and distinct database identities. Runtime database credentials cannot own tables, change schemas, truncate, or hard-delete classroom records.

**Vercel is Ready but the site says “Let’s reconnect”?** A new Neon connection still requires reviewed schema initialization and a restricted runtime role. Follow the [Neon and Vercel first deployment walkthrough](docs/production-database.md#neon-and-vercel-first-deployment-walkthrough) for the exact console steps, private configuration, backup, migration and grant commands. The read-only `npm run db:check` verifies runtime readiness before redeployment. Runtime failures now log safe categories/codes and a request reference rather than only `error`; public visitors do not receive database details.

Builds and server startup never migrate or seed a managed database. Reviewed migrations run through a separate operator command with a verified backup reference and expected schema version. Redeployments reconnect to the same persistent database and preserve existing accounts, passwords, sessions, rosters, activities, trips, and problem reports. An empty, incompatible, or incorrectly scoped database is refused rather than initialized automatically.

Vercel runs `npm ci` and `npm run build`; its local filesystem is not persistent storage. This repository update does not itself create a managed database, configure Vercel, or publish a deployment.

## Existing data and migrations

Schema migrations run transactionally and are versioned. Managed databases require explicit migration and environment binding; local development initializes automatically. Migration 5 retains environment identity and migration auditing. **Migration 6** removes the one-active-class constraint, adds class-specific Pending/Approved/Deactivated status and approval metadata, adds nullable start/end times and extensible weekday arrays, records session cancellation explanations, and adds an atomic username high-water-mark table.

Migration 6 retains account IDs, usernames, password hashes, all existing columns, memberships, historical trips/violations, sessions, questions/learning, audits, and problem reports. Existing enrollment approval states are copied from the legacy account fields. Approval metadata is copied only to the matching current class, and historical audits remain unchanged. Inactive/deactivated memberships stay deactivated. Legacy disabled accounts are conservatively retained as account-wide suspended, separately from enrollments; approving one class cannot clear that restriction. Legacy status fields remain stored for audit compatibility. Unscheduled classes remain unscheduled, and active outside trips can still return. No reset, truncation, or demo seed is part of this migration.

**Production rollout:** verify a backup, review migration 6, pause classroom writes for the migration/code cutover, and run the operator procedure in [the production guide](docs/production-database.md). For a reviewed version-5 database use `npm run db:migrate -- --expected-version 5 --backup-reference YOUR_VERIFIED_BACKUP_ID`. Grant the restricted runtime role `SELECT, INSERT, UPDATE` on `public.student_username_counters`, deploy the matching code, and have each teacher set times on existing classes. Production startup never applies this migration automatically. Existing users keep their accounts and passwords; they do not register again.

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
npm run test:fresh:container
```

Automated coverage includes concurrent sequential usernames, multiple teachers/enrollments, schedule boundaries/DST, session closure, cross-class break exclusion, account approval and migration preservation, current-status enforcement, role/class ownership, teacher and developer authentication, password changes, class codes, roster actions, biology learning and retry protection, tutorials, FIFO/reservation concurrency, timers and warnings, Rule Offenders, return corrections and paused-capacity recovery, report validation and failed-form recovery, and developer ticket search, pagination, and status history.

The PostgreSQL persistence suite creates its own disposable Docker server, verifies repeated application/production-server restarts, and exercises an actual backup/restore. It never uses your `DATABASE_URL`. Docker and OpenSSL are required; run the production build first.

Browser/fresh-development tests preload a test-only server/database clock with one shared offset to a Monday school morning, so schedule-dependent scenarios remain reproducible at night and on weekends. Time advances normally across restarts. `npm run dev`, Codespaces setup, and Vercel never import this test fixture. Backend schedule tests separately cover real IANA offsets, weekends, DST, and exact boundaries.

`npm run test:fresh` checks committed source in a separate temporary Git clone with its own dependency installation, environment, database, and HTTP server. It verifies exact demo logins, enrollment, breaks, automatic private-secret Developer access, repeated setup, preserved changed credentials/status/history, and secret-present and secret-absent setup, late secret injection, and rejected production settings. Commit your changes before running it; it does not test uncommitted edits.

`npm run test:fresh:container` repeats the real devcontainer lifecycle commands in a clean Node 24 Debian Docker container with fresh dependencies and data. It tests all three logins through blank browser forms, Developer access, enrollment, roster, break requests and restart preservation. It uses a generated private test secret by default; an authorized private verification can supply `WATERCYCLE_FRESH_ADMIN_PASSWORD` through a protected environment, never a command-line password. No browser traces or credential artifacts are saved. This simulates Codespaces; it does not create a GitHub Codespace. Docker and installed Chromium are required. For a network with a private certificate authority, supply its public CA bundle through `WATERCYCLE_FRESH_CA_FILE`; TLS verification remains enabled.

Browser tests recreate only **`.local/e2e-data`**. They use a generated test administrator secret and do not reset the application database. Chromium at `/usr/bin/chromium` is used when available; otherwise run `npx playwright install chromium` or set `CHROMIUM_PATH`.

Classroom mutations use transactional row locks, and a student can have only one active break request. Question banks are snapshotted into class-scoped learning attempts, with opaque question tokens and idempotent answer handling. Passwords use salted scrypt hashes; sessions are stored hashed and use HttpOnly, SameSite cookies with Secure on HTTPS. Mutations enforce same-origin requests, validated inputs, and current role/ownership checks. CSV exports neutralize spreadsheet formula cells.

Application data, private environment files, real credentials, dependencies, and generated builds remain outside Git. The demo credentials above are intentionally published for testing.
